import type {
  ProjectConfiguration,
  TargetConfiguration,
  Tree,
} from '@nrwl/devkit';
import {
  joinPathFragments,
  offsetFromRoot,
  updateJson,
  updateProjectConfiguration,
} from '@nrwl/devkit';
import { getRootTsConfigPathInTree } from '@nrwl/workspace/src/utilities/typescript';
import { basename } from 'path';
import { addBuildableLibrariesPostCssDependencies } from '../../../utils/dependencies';
import type {
  Logger,
  ProjectMigrationInfo,
  ValidationError,
  ValidationResult,
} from '../../utilities';
import { arrayToString } from '../../utilities';
import { BuilderMigrator } from './builder.migrator';

export class AngularDevkitNgPackagrMigrator extends BuilderMigrator {
  constructor(
    tree: Tree,
    project: ProjectMigrationInfo,
    projectConfig: ProjectConfiguration,
    logger: Logger
  ) {
    super(
      tree,
      '@angular-devkit/build-angular:ng-packagr',
      undefined,
      project,
      projectConfig,
      logger
    );
  }

  override migrate(): void {
    if (!this.targets.size) {
      this.logger.warn(
        `There is no target in the project configuration using the ${this.builderName} builder. This might not be an issue. ` +
          `Skipping updating the build configuration.`
      );
      return;
    }

    for (const [name, target] of this.targets) {
      this.updateTargetConfiguration(name, target);
      this.updateNgPackageJson(name, target);
      this.updateTsConfigs(name, target);
      this.updateCacheableOperations([name]);
      addBuildableLibrariesPostCssDependencies(this.tree);
    }
  }

  override validate(): ValidationResult {
    const errors: ValidationError[] = [];
    // TODO(leo): keeping restriction until the full refactor is done and we start
    // expanding what's supported.
    if (this.targets.size > 1) {
      errors.push({
        message: `There is more than one target using a builder that is used to build the project (${arrayToString(
          [...this.targets.keys()]
        )}).`,
        hint: `Make sure the project only has one target with a builder that is used to build the project.`,
      });
    }

    return errors.length ? errors : null;
  }

  private updateTargetConfiguration(
    targetName: string,
    target: TargetConfiguration
  ): void {
    target.executor = '@nrwl/angular:package';

    if (
      !target.options &&
      (!target.configurations || !Object.keys(target.configurations).length)
    ) {
      this.logger.warn(
        `The target "${targetName}" is not specifying any options or configurations. Skipping updating the target configuration.`
      );
      return;
    }

    ['project', 'tsConfig'].forEach((option) => {
      if (target.options?.[option]) {
        target.options[option] = joinPathFragments(
          this.project.newRoot,
          basename(target.options[option])
        );
      }

      for (const configuration of Object.values(target.configurations ?? {})) {
        configuration[option] =
          configuration[option] &&
          joinPathFragments(
            this.project.newRoot,
            basename(configuration[option])
          );
      }
    });

    updateProjectConfiguration(this.tree, this.project.name, {
      ...this.projectConfig,
    });
  }

  private updateNgPackageJson(
    targetName: string,
    target: TargetConfiguration
  ): void {
    if (!target.options?.project) {
      this.logger.warn(
        `The "${targetName}" target does not have the "project" option configured. Skipping updating the ng-packagr project file ("ng-package.json").`
      );
      return;
    } else if (!this.tree.exists(target.options.project)) {
      this.logger.warn(
        `The ng-packagr project file "${this.originalProjectConfig.targets[targetName].options.project}" specified in the "${targetName}" ` +
          `target could not be found. Skipping updating the ng-packagr project file.`
      );
      return;
    }

    updateJson(this.tree, target.options.project, (ngPackageJson) => {
      const offset = offsetFromRoot(this.project.newRoot);
      ngPackageJson.$schema =
        ngPackageJson.$schema &&
        `${offset}node_modules/ng-packagr/ng-package.schema.json`;
      ngPackageJson.dest = `${offset}dist/${this.project.name}`;

      return ngPackageJson;
    });
  }

  private updateTsConfigs(
    targetName: string,
    target: TargetConfiguration
  ): void {
    const tsConfigPath =
      target.options?.tsConfig ?? target.configurations?.development?.tsConfig;
    if (!tsConfigPath) {
      this.logger.warn(
        `The "${targetName}" target does not have the "tsConfig" option configured. Skipping updating the tsConfig file.`
      );
      return;
    } else if (!this.tree.exists(tsConfigPath)) {
      const originalTsConfigPath = target.options?.tsConfig
        ? this.originalProjectConfig.targets[targetName].options.tsConfig
        : this.originalProjectConfig.targets[targetName].configurations
            ?.development?.tsConfig;
      this.logger.warn(
        `The tsConfig file "${originalTsConfigPath}" specified in the "${targetName}" target could not be found. Skipping updating the tsConfig file.`
      );
      return;
    }

    const rootTsConfigFile = getRootTsConfigPathInTree(this.tree);
    const projectOffsetFromRoot = offsetFromRoot(this.projectConfig.root);
    this.updateTsConfigFile(
      tsConfigPath,
      rootTsConfigFile,
      projectOffsetFromRoot
    );

    updateJson(this.tree, tsConfigPath, (json) => {
      if (!json.include?.length && !json.files?.length) {
        json.include = ['**/*.ts'];
      }

      return json;
    });
  }
}
