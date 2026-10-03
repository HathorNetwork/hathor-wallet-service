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
 * Stages that deliberately get no alarms.
 *
 * The alarm actions publish to the production OpsGenie topics, so a stage only belongs in
 * `alerts.stages` if its failures should page the production on-call rotation.
 */
const NO_ALARMS = new Set([
  // A development stage: a broken branch deployed here must not page on-call.
  'dev-testnet',
  // A partner deployment in a separate AWS account, with its own operators.
  'ekvi-main',
]);

/**
 * Stages that are alarmed but that the Makefile does not deploy. Keeping the
 * alarms is deliberate — they are cheap, and dropping them would silently
 * remove coverage from an environment deployed by some other means.
 */
const ALARMED_WITHOUT_MAKEFILE_TARGET = new Set(['testnet']);

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
  it('declares alarms for every deployed stage that should page on-call', () => {
    const alertStages = readAlertStages();
    const missing = readDeployedStages()
      .filter((stage) => !NO_ALARMS.has(stage))
      .filter((stage) => !alertStages.includes(stage));

    expect(missing).toStrictEqual([]);
  });

  it('does not wire alarms for stages that must not page on-call', () => {
    const alertStages = readAlertStages();
    const pages = [...NO_ALARMS].filter((stage) => alertStages.includes(stage));

    expect(pages).toStrictEqual([]);
  });

  it('alarms no stage the Makefile does not deploy', () => {
    const deployed = new Set(readDeployedStages());
    const orphaned = readAlertStages()
      .filter((stage) => !deployed.has(stage))
      .filter((stage) => !ALARMED_WITHOUT_MAKEFILE_TARGET.has(stage));

    expect(orphaned).toStrictEqual([]);
  });
});
