import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './ts-loader.mjs';
const { agentPermissionOptions, defaultAgentPermission, validAgentPermission, agentPermissionLabel }=await load('agentPermissions');
const { workflowPlanningInstruction }=await load('agentWorkflow');
test('agent permissions expose native capabilities without claiming unsupported edit modes',()=>{
  assert.deepEqual(agentPermissionOptions('claude').map(o=>o.value),['plan','default','acceptEdits','bypassPermissions']);
  assert.deepEqual(agentPermissionOptions('codex').map(o=>o.value),['plan','read-only','auto','full']);
  assert.deepEqual(agentPermissionOptions('trex').map(o=>o.value),['plan','ask','full']);
  for(const provider of ['claude','codex','trex']){
    assert.equal(defaultAgentPermission(provider,false),'plan');
    for(const option of agentPermissionOptions(provider))assert.ok(validAgentPermission(provider,option.value));
    assert.equal(validAgentPermission(provider,'not-supported'),false);
  }
  assert.equal(validAgentPermission('trex','acceptEdits'),false);
  assert.equal(agentPermissionLabel('trex','auto'),'Preguntar');
  assert.equal(defaultAgentPermission('antigravity'),null);
});
test('planning instructions reflect explicit permission to modify files and preserve the final handoff format',()=>{
  assert.match(workflowPlanningInstruction(false),/sin modificar archivos/);
  const writable=workflowPlanningInstruction(true);assert.match(writable,/Puedes modificar archivos/);assert.match(writable,/<trex_plan>/);
  assert.doesNotMatch(writable,/sin modificar archivos ni implementar|no cambies a modo de implementaci/);
});
