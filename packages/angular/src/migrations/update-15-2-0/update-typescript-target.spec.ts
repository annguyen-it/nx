import {
  readJson,
  readProjectConfiguration,
  Tree,
  updateProjectConfiguration,
  writeJson,
} from '@nrwl/devkit';
import { createTreeWithEmptyWorkspace } from '@nrwl/devkit/testing';
import applicationGenerator from '../../generators/application/application';
import updateTypescriptTarget from './update-typescript-target';
import { UnitTestRunner } from '@nrwl/angular/src/utils/test-runners';

describe('Migration to update target and add useDefineForClassFields', () => {
  let tree: Tree;
  beforeEach(async () => {
    tree = createTreeWithEmptyWorkspace();
    await applicationGenerator(tree, {
      name: 'test',
    });
    await applicationGenerator(tree, {
      name: 'karma',
      unitTestRunner: UnitTestRunner.Karma,
    });

    // Create tsconfigs
    const compilerOptions = { target: 'es2015', module: 'es2020' };
    const configWithExtends = {
      extends: '../../tsconfig.base.json',
      compilerOptions,
    };

    // Workspace
    writeJson(tree, 'tsconfig.base.json', { compilerOptions });

    // Application
    writeJson(tree, 'apps/test/tsconfig.app.json', configWithExtends);
    writeJson(tree, 'apps/test/tsconfig.app.prod.json', configWithExtends);
    writeJson(tree, 'apps/test/tsconfig.spec.json', { compilerOptions });
    writeJson(tree, 'apps/karma/tsconfig.spec.json', { compilerOptions });
  });

  it(`should not update target and not add useDefineForClassFields in workspace 'tsconfig.base.json'`, async () => {
    await updateTypescriptTarget(tree);
    const compilerOptions = readJson(
      tree,
      'tsconfig.base.json'
    ).compilerOptions;
    expect(compilerOptions).toMatchInlineSnapshot(`
      Object {
        "module": "es2020",
        "target": "es2015",
      }
    `);
  });

  it(`should add correct target value and useDefineForClassFields from tsconfig referenced in options and configuration`, async () => {
    const project = readProjectConfiguration(tree, 'test');
    project.targets.build.configurations.production.tsConfig =
      'apps/test/tsconfig.app.prod.json';
    updateProjectConfiguration(tree, 'test', project);

    await updateTypescriptTarget(tree);

    const compilerOptions = readJson(
      tree,
      'apps/test/tsconfig.app.prod.json'
    ).compilerOptions;
    expect(compilerOptions['target']).toEqual('ES2022');
    expect(compilerOptions['useDefineForClassFields']).toBeFalsy();
  });

  it('should add target and useDefineForClassFields when tsconfig is not extended', async () => {
    await updateTypescriptTarget(tree);
    const compilerOptions = readJson(
      tree,
      'apps/karma/tsconfig.spec.json'
    ).compilerOptions;
    expect(compilerOptions).toMatchInlineSnapshot(`
      Object {
        "module": "es2020",
        "target": "ES2022",
        "useDefineForClassFields": false,
      }
    `);
  });
});
