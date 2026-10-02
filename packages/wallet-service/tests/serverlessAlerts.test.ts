import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SERVERLESS_YML = path.join(REPO_ROOT, 'packages/wallet-service/serverless.yml');
const MAKEFILE = path.join(REPO_ROOT, 'Makefile');

/**
 * `serverless.yml` uses Serverless variable syntax (`${self:...}`, `${env:...}`) which is
 * valid YAML scalar text, so a plain parse is enough to read the `custom.alerts.stages` list.
 */
const readAlertStages = (): string[] => {
  const doc = yaml.load(fs.readFileSync(SERVERLESS_YML, 'utf8')) as {
    custom: { alerts: { stages: string[] } };
  };
  return doc.custom.alerts.stages;
};

/**
 * Every `--stage <name>` the Makefile deploys. `invoke-local` is excluded: it runs a function
 * locally and creates no CloudWatch resources, so it needs no alarms.
 */
const readDeployedStages = (): string[] => {
  const makefile = fs.readFileSync(MAKEFILE, 'utf8');
  const stages = new Set<string>();
  for (const line of makefile.split('\n')) {
    if (!line.includes('serverless deploy')) continue;
    const match = line.match(/--stage\s+(\S+)/);
    if (match) stages.add(match[1]);
  }
  return [...stages];
};

describe('serverless alert stages', () => {
  it('declares alarms for every stage the Makefile deploys', () => {
    const alertStages = readAlertStages();
    const missing = readDeployedStages().filter((stage) => !alertStages.includes(stage));

    expect(missing).toStrictEqual([]);
  });
});
