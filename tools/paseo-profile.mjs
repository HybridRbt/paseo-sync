#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { realpath } from 'node:fs/promises';
import { objectHash, privateRoot, jsonOrNull, safeFile } from '../server/core/files.mjs';
import { makeAdapter, assertDaemonVersion } from '../server/core/paseo.mjs';
import { buildPlan, applyPlan, verify, restorePlan, restore } from '../server/core/sync.mjs';
import { exportProfile } from '../server/core/export.mjs';
import { snapshotPlugin } from '../server/core/profile.mjs';

const help=`Paseo configuration profile (Node.js >=22.18, Paseo >=0.11.4)

node tools/paseo-profile.mjs inspect
node tools/paseo-profile.mjs export
node tools/paseo-profile.mjs plan [--prefer-profile]
node tools/paseo-profile.mjs apply --approve <plan.approval> [--prefer-profile]
node tools/paseo-profile.mjs verify
node tools/paseo-profile.mjs restore --backup <id> [--approve <restore.approval>]

Options: --repo <directory> --home <local Paseo home> --paseo <CLI path>
All operations target the LOCAL daemon. There is no remote-host option.
Without --approve, apply refuses changes; restore only previews.
--prefer-profile explicitly resolves local baseline conflicts in favor of the repository.
Credentials, pairing data, sessions and arbitrary plugin data are never synchronized.
`;
try{
  const {values,positionals}=parseArgs({allowPositionals:true,options:{repo:{type:'string'},home:{type:'string'},paseo:{type:'string'},approve:{type:'string'},backup:{type:'string'},'prefer-profile':{type:'boolean'},help:{type:'boolean'}}});
  if(values.help){process.stdout.write(help);process.exit(0);}
  const command=positionals[0];
  if(positionals.length!==1||!['inspect','export','plan','apply','verify','restore'].includes(command))throw new Error(help);
  const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<18))throw new Error('Node.js >=22.18 is required');
  if(values.approve&&!['apply','restore'].includes(command))throw new Error('--approve only applies to apply/restore');
  if(values.backup&&command!=='restore')throw new Error('--backup only applies to restore');
  if(values['prefer-profile']&&!['plan','apply'].includes(command))throw new Error('--prefer-profile only applies to plan/apply');
  const root=await realpath(path.resolve(values.repo??path.join(path.dirname(fileURLToPath(import.meta.url)),'..')));
  const home=await realpath(path.resolve(values.home??process.env.PASEO_HOME??path.join(os.homedir(),'.paseo')));
  const stateRoot=process.platform==='win32'?path.join(process.env.LOCALAPPDATA??os.homedir(),'PaseoProfile'):path.join(os.homedir(),'.local','state','paseo-profile');
  const state=path.join(stateRoot,objectHash({root,home}).slice(0,24));
  // Keep profiles separate per checkout and daemon home; never commit the state directory.
  await privateRoot(state);
  const adapter=await makeAdapter(home,values.paseo),ctx={root,home,state,adapter,preferProfile:values['prefer-profile']===true};
  const daemonStatus=await adapter.status();
  if(command!=='inspect')assertDaemonVersion(daemonStatus.daemonVersion);
  let result;
  if(command==='inspect'){
    const rows=await adapter.list(),config=await jsonOrNull(await safeFile(home,'config.json'));
    result={home,stateDirectory:state,daemonVersion:daemonStatus.daemonVersion??null,pluginsEnabled:config?.pluginsEnabled===true,plugins:rows.map(r=>({...snapshotPlugin(r),status:r.status})),settingsScope:'Better Paseo presentation only; native client settings and credentials remain local'};
  }else if(command==='export')result=await exportProfile(ctx);
  else if(command==='plan')result=await buildPlan(ctx);
  else if(command==='apply'){
    if(!values.approve)throw new Error('Run plan and supply its approval digest using --approve.');
    result=await applyPlan(ctx,values.approve);
  }else if(command==='verify'){
    result=await verify(ctx);if(!result.configurationMatches||!result.runtimeHealthy)process.exitCode=2;
  }else{
    if(!values.backup)throw new Error('restore requires --backup <id>');
    if(values.approve)result=await restore(ctx,values.backup,values.approve);
    else{const {_backup,_current,...publicPreview}=await restorePlan(ctx,values.backup);result=publicPreview;}
  }
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){
  process.stderr.write(JSON.stringify({error:error.message,...(error.backupId?{backupId:error.backupId,backupFile:error.backupFile}:{} )},null,2)+'\n');process.exitCode=1;
}
