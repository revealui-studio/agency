/** Stage log-only rules for review; never publishes or changes an existing rule. */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(
  await readFile(new URL('../config/consultation-firewall.json', import.meta.url), 'utf8'),
);
const project = JSON.parse(
  await readFile(new URL('../.vercel/project.json', import.meta.url), 'utf8'),
);
if (project.projectName !== config.project) throw new Error('Unexpected linked Vercel project');
const listed = spawnSync('vercel', ['firewall', 'rules', 'list', '--json'], { encoding: 'utf8' });
if (listed.status !== 0) throw new Error('Cannot inspect existing firewall rules');
const existing = JSON.parse(listed.stdout) as {
  rules: Array<{
    name: string;
    conditionGroup: Array<{ conditions: Array<{ type: string; value: string }> }>;
  }>;
};
for (const rule of config.rules) {
  const found = existing.rules.filter((item) => item.name === rule.id);
  if (found.length) {
    if (
      found.length !== 1 ||
      !found[0]?.conditionGroup.some((group) =>
        group.conditions.some(
          (condition) => condition.type === 'rate_limit_api_id' && condition.value === rule.id,
        ),
      )
    )
      throw new Error(`Conflicting rule: ${rule.id}`);
    console.log(`Keeping existing rule: ${rule.id}`);
    continue;
  }
  const result = spawnSync(
    'vercel',
    [
      'firewall',
      'rules',
      'add',
      rule.id,
      '--condition',
      JSON.stringify({ type: 'rate_limit_api_id', op: 'eq', value: rule.id }),
      '--action',
      'rate_limit',
      '--rate-limit-window',
      String(config.windowSeconds),
      '--rate-limit-requests',
      String(rule.requests * 5),
      '--rate-limit-action',
      'log',
      '--rate-limit-algo',
      config.algorithm,
      '--yes',
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
