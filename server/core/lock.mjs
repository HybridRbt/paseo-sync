import { mkdir, rm } from 'node:fs/promises';
import { privateRoot, safeFile } from './files.mjs';
export async function withOperation(ctx,fn){
 const root=ctx.lockRoot??ctx.state;await privateRoot(root);const lock=await safeFile(root,'operation.lock');
 try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')throw new Error('Another operation is active, or an interrupted operation needs review.');throw e;}
 try{return await fn();}finally{await rm(lock,{recursive:true,force:true});}
}
