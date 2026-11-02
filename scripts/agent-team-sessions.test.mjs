import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { load } from "./ts-loader.mjs";
const url=new URL("./queue-send-now.test.mjs",import.meta.url), source=await readFile(url,"utf8"), ast=ts.createSourceFile(url.pathname,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
let body=ast.statements.filter(node=>ts.isVariableStatement(node)||ts.isFunctionDeclaration(node)).map(node=>node.getText(ast)).join("\n").replaceAll("import.meta.url",JSON.stringify(url.href));
body=body.replace('model: "offline-model", items: [], recoveryRequired: !!extra.recovery','model: "offline-model", items: [], recoveryRequired: !!extra.recovery, teamEnabled: !!message.params.team && extra.teamAck !== false, rolePolicyApplied: !!message.params.roleInstructions && extra.roleAck !== false');
body=body.replaceAll('{ thread: { id: conversation }, model: "offline-model" }','{ thread: { id: conversation }, model: "offline-model", ...(extra.planningOnly ? {sandboxPolicy:{type:"readOnly"},approvalPolicy:"on-request"}: {}) }');
const base=await new (Object.getPrototypeOf(async function(){}).constructor)("assert","readFile","ts","load",body+"\nreturn {harness,flush,dependencies};")(assert,readFile,ts,load);
const binding={id:"team-1",epoch:"epoch-1"}, config={command:"C:\\Trex\\trex.exe",args:["--trex-team-mcp","C:\\private","team-1","epoch-1"],callArgs:["--trex-team-call","C:\\private","team-1","epoch-1"]};
for(const provider of ["claude","codex","trex"]){
  test(provider+": a writable principal retains delegation tools and the selected native write policy",async t=>{
    const mode=provider==="claude"?"acceptEdits":"full";
    const h=base.harness(t,provider,{planningOnly:false,mode,team:binding,teamConfig:config,model:"offline-model"});
    assert.equal(await h.session.send("Inspect and edit with the selected permissions",[],[]),true);h.render();
    if(provider==="claude"){
      const flags=h.spawns[0].request.flags;assert.equal(flags[flags.indexOf("--permission-mode")+1],mode);assert.ok(flags.includes("--allowedTools"));
    }else if(provider==="codex"){
      const turn=h.writes.find(w=>w.method==="turn/start");assert.equal(turn.params.sandboxPolicy.type,"dangerFullAccess");assert.equal(turn.params.approvalPolicy,"never");
      assert.ok(h.writes.find(w=>w.method==="thread/start").params.config["mcp_servers.trex_team.command"]);
    }else{
      const start=h.writes.find(w=>w.method==="session/start");assert.equal(start.params.mode,"full");assert.deepEqual(start.params.team,{command:config.command,args:config.callArgs});
    }
  });
  test(provider+": principal receives only the fixed team tools and custom read-only role policy",async t=>{
    const h=base.harness(t,provider,{planningOnly:true,mode:"plan",team:binding,teamConfig:config,planningInstruction:"Coordinate using the configured collaborators. Never implement directly.",model:"offline-model",effort:"max"});
    assert.equal(await h.session.send("Delegate implementation and review",[],[]),true);h.render();const spawn=h.spawns[0].request;
    if(provider==="claude"){
      const mcp=JSON.parse(spawn.flags[spawn.flags.indexOf("--mcp-config")+1]).mcpServers.trex_team;assert.equal(mcp.command,config.command);assert.deepEqual(mcp.args,config.args);assert.equal(mcp.timeout,1900000);assert.equal(spawn.env.CLAUDE_AUTO_BACKGROUND_TASKS,"0");
      assert.deepEqual(spawn.flags[spawn.flags.indexOf("--allowedTools")+1].split(","),["mcp__trex_team__trex_team_members","mcp__trex_team__trex_delegate_task","mcp__trex_team__trex_task_status","mcp__trex_team__trex_team_plan"]);
      const request={type:"control_request",request_id:"delegate-permission",request:{subtype:"can_use_tool",tool_name:"mcp__trex_team__trex_delegate_task",input:{memberId:"worker",taskKey:"key",task:"Implement"}}};h.line(request);h.render();const item=h.state.items.find(item=>item.kind==="permission"&&item.id==="delegate-permission");if(item)h.session.answer(item,true,false);
      assert.ok(!h.writes.some(w=>w.type==="control_response"&&w.response.request_id==="delegate-permission"&&w.response.response?.behavior==="deny"));
      h.line({type:"control_request",request_id:"write",request:{subtype:"can_use_tool",tool_name:"Write",input:{file_path:"a.ts",content:"bad"}}});await base.flush();assert.ok(h.writes.some(w=>w.response?.request_id==="write"&&w.response.response?.behavior==="deny"));
    }else if(provider==="codex"){
      const settings=h.writes.find(w=>w.method==="thread/start").params.config;
      assert.equal(settings["mcp_servers.trex_team.command"],config.command);assert.deepEqual(settings["mcp_servers.trex_team.args"],config.args);assert.equal(settings["mcp_servers.trex_team.tool_timeout_sec"],1900);
      const start=h.writes.find(w=>w.method==="thread/start"),turn=h.writes.find(w=>w.method==="turn/start");assert.equal(start.params.sandbox,"read-only");assert.match(start.params.developerInstructions,/configured collaborators/);assert.equal(turn.params.collaborationMode.settings.developer_instructions,"Coordinate using the configured collaborators. Never implement directly.");
    }else{
      const start=h.writes.find(w=>w.method==="session/start");assert.equal(start.params.mode,"plan");assert.deepEqual(start.params.team,{command:config.command,args:config.callArgs});assert.match(start.params.roleInstructions,/configured collaborators/);
    }
  });
  test(provider+": ordinary collaborators receive no team transport",async t=>{
    const h=base.harness(t,provider,{mode:"auto",model:"offline-model"});assert.equal(await h.session.send("Execute task",[],[]),true);assert.ok(!JSON.stringify(h.spawns).includes("trex_team"));assert.ok(!h.writes.some(w=>w.params?.team));
  });
}
for(const ack of ["teamAck","roleAck"])test("Trex refuses to send when the installed CLI omits "+ack,async t=>{
  const h=base.harness(t,"trex",{planningOnly:true,team:binding,teamConfig:config,planningInstruction:"Coordinate.",model:"offline-model",[ack]:false});assert.equal(await h.session.send("Must not be sent",[],[]),false);assert.equal(h.userWrites.length,0);
});
test("read-only worker uses its custom reporting policy without gaining delegation tools",async t=>{
  const h=base.harness(t,"codex",{planningOnly:true,planningInstruction:"Report verified findings, not a two-stage plan.",model:"offline-model"});assert.equal(await h.session.send("Review the code",[],[]),true);const start=h.writes.find(w=>w.method==="thread/start");assert.match(start.params.developerInstructions,/Report verified findings/);assert.ok(!JSON.stringify(h.spawns).includes("trex_team"));
});
