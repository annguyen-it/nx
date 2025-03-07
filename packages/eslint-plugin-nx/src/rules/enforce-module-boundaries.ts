import {
  joinPathFragments,
  normalizePath,
  ProjectGraphExternalNode,
  ProjectGraphProjectNode,
  workspaceRoot,
} from '@nrwl/devkit';
import { isRelativePath } from 'nx/src/utils/fileutils';
import {
  checkCircularPath,
  findFilesInCircularPath,
} from '../utils/graph-utils';
import {
  DepConstraint,
  findConstraintsFor,
  findDependenciesWithTags,
  findProjectUsingImport,
  findSourceProject,
  findTransitiveExternalDependencies,
  findTargetProject,
  getSourceFilePath,
  getTargetProjectBasedOnRelativeImport,
  groupImports,
  hasBannedDependencies,
  hasBannedImport,
  hasBuildExecutor,
  hasNoneOfTheseTags,
  isAbsoluteImportIntoAnotherProject,
  isAngularSecondaryEntrypoint,
  isDirectDependency,
  matchImportWithWildcard,
  onlyLoadChildren,
  stringifyTags,
} from '../utils/runtime-lint-utils';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/utils';
import { TargetProjectLocator } from 'nx/src/utils/target-project-locator';
import { basename, dirname, relative } from 'path';
import {
  getBarrelEntryPointByImportScope,
  getBarrelEntryPointProjectNode,
  getRelativeImportPath,
} from '../utils/ast-utils';
import { createESLintRule } from '../utils/create-eslint-rule';
import { readProjectGraph } from '../utils/project-graph-utils';

type Options = [
  {
    allow: string[];
    depConstraints: DepConstraint[];
    enforceBuildableLibDependency: boolean;
    allowCircularSelfDependency: boolean;
    banTransitiveDependencies: boolean;
    checkNestedExternalImports: boolean;
  }
];
export type MessageIds =
  | 'noRelativeOrAbsoluteImportsAcrossLibraries'
  | 'noSelfCircularDependencies'
  | 'noCircularDependencies'
  | 'noImportsOfApps'
  | 'noImportsOfE2e'
  | 'noImportOfNonBuildableLibraries'
  | 'noImportsOfLazyLoadedLibraries'
  | 'projectWithoutTagsCannotHaveDependencies'
  | 'bannedExternalImportsViolation'
  | 'nestedBannedExternalImportsViolation'
  | 'noTransitiveDependencies'
  | 'onlyTagsConstraintViolation'
  | 'emptyOnlyTagsConstraintViolation'
  | 'notTagsConstraintViolation';
export const RULE_NAME = 'enforce-module-boundaries';

export default createESLintRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'suggestion',
    docs: {
      description: `Ensure that module boundaries are respected within the monorepo`,
      recommended: 'error',
    },
    fixable: 'code',
    schema: [
      {
        type: 'object',
        properties: {
          enforceBuildableLibDependency: { type: 'boolean' },
          allowCircularSelfDependency: { type: 'boolean' },
          banTransitiveDependencies: { type: 'boolean' },
          checkNestedExternalImports: { type: 'boolean' },
          allow: [{ type: 'string' }],
          depConstraints: [
            {
              type: 'object',
              properties: {
                sourceTag: { type: 'string' },
                onlyDependOnLibsWithTags: [{ type: 'string' }],
                bannedExternalImports: [{ type: 'string' }],
                notDependOnLibsWithTags: [{ type: 'string' }],
              },
              additionalProperties: false,
            },
          ],
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noRelativeOrAbsoluteImportsAcrossLibraries: `Projects cannot be imported by a relative or absolute path, and must begin with a npm scope`,
      noCircularDependencies: `Circular dependency between "{{sourceProjectName}}" and "{{targetProjectName}}" detected: {{path}}\n\nCircular file chain:\n{{filePaths}}`,
      noSelfCircularDependencies: `Projects should use relative imports to import from other files within the same project. Use "./path/to/file" instead of import from "{{imp}}"`,
      noImportsOfApps: 'Imports of apps are forbidden',
      noImportsOfE2e: 'Imports of e2e projects are forbidden',
      noImportOfNonBuildableLibraries:
        'Buildable libraries cannot import or export from non-buildable libraries',
      noImportsOfLazyLoadedLibraries: `Imports of lazy-loaded libraries are forbidden`,
      projectWithoutTagsCannotHaveDependencies: `A project without tags matching at least one constraint cannot depend on any libraries`,
      bannedExternalImportsViolation: `A project tagged with "{{sourceTag}}" is not allowed to import the "{{package}}" package`,
      nestedBannedExternalImportsViolation: `A project tagged with "{{sourceTag}}" is not allowed to import the "{{package}}" package. Nested import found at {{childProjectName}}`,
      noTransitiveDependencies: `Transitive dependencies are not allowed. Only packages defined in the "package.json" can be imported`,
      onlyTagsConstraintViolation: `A project tagged with "{{sourceTag}}" can only depend on libs tagged with {{tags}}`,
      emptyOnlyTagsConstraintViolation:
        'A project tagged with "{{sourceTag}}" cannot depend on any libs with tags',
      notTagsConstraintViolation: `A project tagged with "{{sourceTag}}" can not depend on libs tagged with {{tags}}\n\nViolation detected in:\n{{projects}}`,
    },
  },
  defaultOptions: [
    {
      allow: [],
      depConstraints: [],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      banTransitiveDependencies: false,
      checkNestedExternalImports: false,
    },
  ],
  create(
    context,
    [
      {
        allow,
        depConstraints,
        enforceBuildableLibDependency,
        allowCircularSelfDependency,
        banTransitiveDependencies,
        checkNestedExternalImports,
      },
    ]
  ) {
    /**
     * Globally cached info about workspace
     */
    const projectPath = normalizePath(
      (global as any).projectPath || workspaceRoot
    );
    const fileName = normalizePath(context.getFilename());

    const { projectGraph, projectGraphFileMappings } =
      readProjectGraph(RULE_NAME);

    if (!projectGraph) {
      return {};
    }

    const workspaceLayout = (global as any).workspaceLayout;

    if (!(global as any).targetProjectLocator) {
      (global as any).targetProjectLocator = new TargetProjectLocator(
        projectGraph.nodes,
        projectGraph.externalNodes
      );
    }
    const targetProjectLocator = (global as any)
      .targetProjectLocator as TargetProjectLocator;

    function run(
      node:
        | TSESTree.ImportDeclaration
        | TSESTree.ImportExpression
        | TSESTree.ExportAllDeclaration
        | TSESTree.ExportNamedDeclaration
    ) {
      // Ignoring ExportNamedDeclarations like:
      // export class Foo {}
      if (!node.source) {
        return;
      }

      // accept only literals because template literals have no value
      if (node.source.type !== AST_NODE_TYPES.Literal) {
        return;
      }

      const imp = node.source.value as string;

      // whitelisted import
      if (allow.some((a) => matchImportWithWildcard(a, imp))) {
        return;
      }

      const sourceFilePath = getSourceFilePath(fileName, projectPath);

      const sourceProject = findSourceProject(
        projectGraph,
        projectGraphFileMappings,
        sourceFilePath
      );
      // If source is not part of an nx workspace, return.
      if (!sourceProject) {
        return;
      }

      // check for relative and absolute imports
      const isAbsoluteImportIntoAnotherProj =
        isAbsoluteImportIntoAnotherProject(imp, workspaceLayout);
      let targetProject: ProjectGraphProjectNode | ProjectGraphExternalNode;

      if (isAbsoluteImportIntoAnotherProj) {
        targetProject = findTargetProject(
          projectGraph,
          projectGraphFileMappings,
          imp
        );
      } else {
        targetProject = getTargetProjectBasedOnRelativeImport(
          imp,
          projectPath,
          projectGraph,
          projectGraphFileMappings,
          sourceFilePath
        );
      }

      if (
        (targetProject && sourceProject !== targetProject) ||
        isAbsoluteImportIntoAnotherProj
      ) {
        context.report({
          node,
          messageId: 'noRelativeOrAbsoluteImportsAcrossLibraries',
          fix(fixer) {
            if (targetProject) {
              const indexTsPaths = getBarrelEntryPointProjectNode(
                targetProject as ProjectGraphProjectNode
              );

              if (indexTsPaths && indexTsPaths.length > 0) {
                const specifiers = (node as any).specifiers;
                if (!specifiers || specifiers.length === 0) {
                  return;
                }

                const imports = specifiers
                  .filter((s) => s.type === 'ImportSpecifier')
                  .map((s) => s.imported.name);

                // process each potential entry point and try to find the imports
                const importsToRemap = [];

                for (const entryPointPath of indexTsPaths) {
                  for (const importMember of imports) {
                    const importPath = getRelativeImportPath(
                      importMember,
                      joinPathFragments(workspaceRoot, entryPointPath.path),
                      sourceProject.data.sourceRoot
                    );
                    // we cannot remap, so leave it as is
                    if (importPath) {
                      importsToRemap.push({
                        member: importMember,
                        importPath: entryPointPath.importScope,
                      });
                    }
                  }
                }

                const adjustedRelativeImports = groupImports(importsToRemap);

                if (adjustedRelativeImports !== '') {
                  return fixer.replaceTextRange(
                    node.range,
                    adjustedRelativeImports
                  );
                }
              }
            }
          },
        });
        return;
      }

      targetProject =
        targetProject ||
        findProjectUsingImport(
          projectGraph,
          targetProjectLocator,
          sourceFilePath,
          imp
        );

      // If target is not part of an nx workspace, return.
      if (!targetProject) {
        return;
      }

      // we only allow relative paths within the same project
      // and if it's not a secondary entrypoint in an angular lib
      if (sourceProject === targetProject) {
        if (
          !allowCircularSelfDependency &&
          !isRelativePath(imp) &&
          !isAngularSecondaryEntrypoint(targetProjectLocator, imp)
        ) {
          context.report({
            node,
            messageId: 'noSelfCircularDependencies',
            data: {
              imp,
            },
            fix(fixer) {
              // imp has form of @myorg/someproject/some/path
              const indexTsPaths = getBarrelEntryPointByImportScope(imp);
              if (indexTsPaths && indexTsPaths.length > 0) {
                const specifiers = (node as any).specifiers;
                if (!specifiers || specifiers.length === 0) {
                  return;
                }
                // imported JS functions to remap
                const imports = specifiers
                  .filter((s) => s.type === 'ImportSpecifier')
                  .map((s) => s.imported.name);

                // process each potential entry point and try to find the imports
                const importsToRemap = [];

                for (const entryPointPath of indexTsPaths) {
                  for (const importMember of imports) {
                    const importPath = getRelativeImportPath(
                      importMember,
                      joinPathFragments(workspaceRoot, entryPointPath),
                      sourceProject.data.sourceRoot
                    );
                    if (importPath) {
                      // resolve the import path
                      const relativePath = relative(
                        dirname(fileName),
                        dirname(importPath)
                      );

                      // if the string is empty, it's the current file
                      const importPathResolved =
                        relativePath === ''
                          ? `./${basename(importPath)}`
                          : joinPathFragments(
                              relativePath,
                              basename(importPath)
                            );

                      importsToRemap.push({
                        member: importMember,
                        importPath: importPathResolved.replace('.ts', ''),
                      });
                    }
                  }
                }

                const adjustedRelativeImports = groupImports(importsToRemap);
                if (adjustedRelativeImports !== '') {
                  return fixer.replaceTextRange(
                    node.range,
                    adjustedRelativeImports
                  );
                }
              }
            },
          });
        }
        return;
      }

      // project => npm package
      if (targetProject.type === 'npm') {
        if (banTransitiveDependencies && !isDirectDependency(targetProject)) {
          context.report({
            node,
            messageId: 'noTransitiveDependencies',
          });
        }
        const constraint = hasBannedImport(
          sourceProject,
          targetProject,
          depConstraints
        );
        if (constraint) {
          context.report({
            node,
            messageId: 'bannedExternalImportsViolation',
            data: {
              sourceTag: constraint.sourceTag,
              package: targetProject.data.packageName,
            },
          });
        }
        return;
      }

      // check constraints between libs and apps
      // check for circular dependency
      const circularPath = checkCircularPath(
        projectGraph,
        sourceProject,
        targetProject
      );
      if (circularPath.length !== 0) {
        const circularFilePath = findFilesInCircularPath(circularPath);

        // spacer text used for indirect dependencies when printing one line per file.
        // without this, we can end up with a very long line that does not display well in the terminal.
        const spacer = '  ';

        context.report({
          node,
          messageId: 'noCircularDependencies',
          data: {
            sourceProjectName: sourceProject.name,
            targetProjectName: targetProject.name,
            path: circularPath.reduce(
              (acc, v) => `${acc} -> ${v.name}`,
              sourceProject.name
            ),
            filePaths: circularFilePath
              .map((files) =>
                files.length > 1
                  ? `[${files
                      .map((f) => `\n${spacer}${spacer}${f}`)
                      .join(',')}\n${spacer}]`
                  : files[0]
              )
              .reduce(
                (acc, files) => `${acc}\n- ${files}`,
                `- ${sourceFilePath}`
              ),
          },
        });
        return;
      }

      // cannot import apps
      if (targetProject.type === 'app') {
        context.report({
          node,
          messageId: 'noImportsOfApps',
        });
        return;
      }

      // cannot import e2e projects
      if (targetProject.type === 'e2e') {
        context.report({
          node,
          messageId: 'noImportsOfE2e',
        });
        return;
      }

      // buildable-lib is not allowed to import non-buildable-lib
      if (
        enforceBuildableLibDependency === true &&
        sourceProject.type === 'lib' &&
        targetProject.type === 'lib'
      ) {
        if (
          hasBuildExecutor(sourceProject) &&
          !hasBuildExecutor(targetProject)
        ) {
          context.report({
            node,
            messageId: 'noImportOfNonBuildableLibraries',
          });
          return;
        }
      }

      // if we import a library using loadChildren, we should not import it using es6imports
      if (
        node.type === AST_NODE_TYPES.ImportDeclaration &&
        node.importKind !== 'type' &&
        onlyLoadChildren(
          projectGraph,
          sourceProject.name,
          targetProject.name,
          []
        )
      ) {
        context.report({
          node,
          messageId: 'noImportsOfLazyLoadedLibraries',
        });
        return;
      }

      // check that dependency constraints are satisfied
      if (depConstraints.length > 0) {
        const constraints = findConstraintsFor(depConstraints, sourceProject);
        // when no constrains found => error. Force the user to provision them.
        if (constraints.length === 0) {
          context.report({
            node,
            messageId: 'projectWithoutTagsCannotHaveDependencies',
          });
          return;
        }

        const transitiveExternalDeps = checkNestedExternalImports
          ? findTransitiveExternalDependencies(projectGraph, targetProject)
          : [];

        for (let constraint of constraints) {
          if (
            constraint.onlyDependOnLibsWithTags &&
            constraint.onlyDependOnLibsWithTags.length &&
            hasNoneOfTheseTags(
              targetProject,
              constraint.onlyDependOnLibsWithTags
            )
          ) {
            context.report({
              node,
              messageId: 'onlyTagsConstraintViolation',
              data: {
                sourceTag: constraint.sourceTag,
                tags: stringifyTags(constraint.onlyDependOnLibsWithTags),
              },
            });
            return;
          }
          if (
            constraint.onlyDependOnLibsWithTags &&
            constraint.onlyDependOnLibsWithTags.length === 0 &&
            targetProject.data.tags.length !== 0
          ) {
            context.report({
              node,
              messageId: 'emptyOnlyTagsConstraintViolation',
              data: {
                sourceTag: constraint.sourceTag,
              },
            });
            return;
          }
          if (
            constraint.notDependOnLibsWithTags &&
            constraint.notDependOnLibsWithTags.length
          ) {
            const projectPaths = findDependenciesWithTags(
              targetProject,
              constraint.notDependOnLibsWithTags,
              projectGraph
            );
            if (projectPaths.length > 0) {
              context.report({
                node,
                messageId: 'notTagsConstraintViolation',
                data: {
                  sourceTag: constraint.sourceTag,
                  tags: stringifyTags(constraint.notDependOnLibsWithTags),
                  projects: projectPaths
                    .map(
                      (projectPath) =>
                        `- ${projectPath.map((p) => p.name).join(' -> ')}`
                    )
                    .join('\n'),
                },
              });
              return;
            }
          }
          if (
            checkNestedExternalImports &&
            constraint.bannedExternalImports &&
            constraint.bannedExternalImports.length
          ) {
            const matches = hasBannedDependencies(
              transitiveExternalDeps,
              projectGraph,
              constraint
            );
            if (matches.length > 0) {
              matches.forEach(([target, violatingSource, constraint]) => {
                context.report({
                  node,
                  messageId: 'bannedExternalImportsViolation',
                  data: {
                    sourceTag: constraint.sourceTag,
                    childProjectName: violatingSource.name,
                    package: target.data.packageName,
                  },
                });
              });
              return;
            }
          }
        }
      }
    }

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        run(node);
      },
      ImportExpression(node: TSESTree.ImportExpression) {
        run(node);
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration) {
        run(node);
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration) {
        run(node);
      },
    };
  },
});
