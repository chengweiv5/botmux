import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, symlinkSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { prepareDocCommentNegativeMaskRoot } from '../src/platform/doc-comment-storage-root.js';
import { prepareCredentialOnlySandbox } from '../src/adapters/backend/sandbox.js';
import { tsEvalArgs } from './helpers/ts-runner.js';
import { DocCommentNegativeStore } from '../src/services/doc-comment-negative-store.js';

const usable = process.platform === 'linux' && spawnSync('bwrap',['--ro-bind','/','/','--unshare-user','--unshare-pid','--proc','/proc','/bin/true'],{stdio:'ignore',timeout:5000}).status===0;
vi.mock('node:fs',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs')>();return {...actual,fsyncSync:vi.fn(actual.fsyncSync)};
});
describe('credential-only comment mask lifecycle',()=>{
  it('prepares an absent root and rejects unsafe existing roots without following or repairing them',()=>{
    const dir=realpathSync(mkdtempSync('/tmp/comment-mask-root-'));
    try {
      const root=join(dir,'doc-comment-negative');
      expect(prepareDocCommentNegativeMaskRoot(dir)).toBe(root);
      expect(lstatSync(root).mode&0o777).toBe(0o700);
      expect(prepareDocCommentNegativeMaskRoot(dir)).toBe(root);
      chmodSync(root,0o777);expect(()=>prepareDocCommentNegativeMaskRoot(dir)).toThrow('negative_mask_root_unsafe');
      chmodSync(root,0o700);rmSync(root,{recursive:true});
      const other=join(dir,'other');mkdirSync(other);symlinkSync(other,root);
      expect(()=>prepareDocCommentNegativeMaskRoot(dir)).toThrow('negative_mask_root_unsafe');
      expect(lstatSync(root).isSymbolicLink()).toBe(true);
      rmSync(root);writeFileSync(root,'not a directory');
      expect(()=>prepareDocCommentNegativeMaskRoot(dir)).toThrow('negative_mask_root_unsafe');
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it('fails closed on directory flush failure or a replaceable ancestor',()=>{
    const dir=realpathSync(mkdtempSync('/tmp/comment-mask-fail-'));
    try {
      vi.mocked(fs.fsyncSync).mockImplementationOnce(()=>{throw new Error('negative_root_fsync_failed')});
      expect(()=>prepareDocCommentNegativeMaskRoot(dir)).toThrow('negative_root_fsync_failed');
      expect(prepareDocCommentNegativeMaskRoot(dir)).toBe(join(dir,'doc-comment-negative'));
      const parent=join(dir,'unsafe');mkdirSync(parent);chmodSync(parent,0o777);
      const data=join(parent,'data');mkdirSync(data);
      expect(()=>prepareDocCommentNegativeMaskRoot(data)).toThrow('宿主凭证目录可被不可信祖先目录替换');
      chmodSync(parent,0o700);
    }finally{vi.restoreAllMocks();rmSync(dir,{recursive:true,force:true});}
  });
  it.runIf(usable)('protects host comment records created after a persistent CLI has already started',async()=>{
    const dir=realpathSync(mkdtempSync('/tmp/comment-late-root-'));let child:ChildProcess|undefined;
    try {
      const data=join(dir,'data');mkdirSync(data);const root=join(data,'doc-comment-negative');
      expect(existsSync(root)).toBe(false);
      const prepared=prepareDocCommentNegativeMaskRoot(data);
      // A second mandatory mask mirrors the old valid credential-only launch
      // even when the comment root was skipped entirely.
      const device=join(dir,'device');mkdirSync(device);
      const evalArgs=tsEvalArgs(`
        import fs from 'node:fs';process.stdout.write('READY\\n');
        process.stdin.once('data',bytes=>{
          const paths=JSON.parse(bytes.toString());
          let read=false,write=false;for(const path of paths){try{fs.readFileSync(path);read=true}catch{}
          try{fs.writeFileSync(path,'FORGED');write=true}catch{}}
          fs.writeFileSync(${JSON.stringify(join(dir,'ordinary'))},'OK');
          console.log(JSON.stringify({read,write}));process.exit(0);
        });
      `);
      const launch=prepareCredentialOnlySandbox({hideDirectories:[device,...(prepared?[prepared]:[])],hideFiles:[],workingDir:dir,cliBin:evalArgs.command,cliArgs:evalArgs.args});
      expect(launch).toBeTruthy();child=spawn(launch!.bin,launch!.args,{stdio:['pipe','pipe','pipe']});
      let output='';let errors='';child.stdout!.on('data',b=>output+=b);child.stderr!.on('data',b=>errors+=b);
      const exited=new Promise<void>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',()=>resolve());});
      const deadline=Date.now()+5000;
      while(!output.includes('READY')&&Date.now()<deadline&&child.exitCode===null)await new Promise(r=>setTimeout(r,10));
      expect(output,errors).toContain('READY');
      // Real host store enrollment happens only AFTER CLI READY: SQLite, epoch,
      // and recovery audit destinations all sit below the pre-masked root.
      const store=new DocCommentNegativeStore(data);
      let statePath:string;let dbPath:string;
      try {store.initialize('app','file');({state:statePath,db:dbPath}=store.paths('app','file'));}
      finally{store.close();}
      const beforeState=readFileSync(statePath!, 'utf8');const beforeDb=readFileSync(dbPath!);
      child.stdin!.end(JSON.stringify([statePath!,dbPath!]));await exited;
      expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({read:false,write:false});
      expect(readFileSync(statePath!, 'utf8')).toBe(beforeState);
      expect(readFileSync(dbPath!)).toEqual(beforeDb);
      expect(readFileSync(join(dir,'ordinary'),'utf8')).toBe('OK');
      expect(prepared).toBeDefined();
    } finally {if(child?.exitCode===null){const ended=new Promise(r=>child!.once('exit',r));child.kill('SIGKILL');await ended;}rmSync(dir,{recursive:true,force:true});}
  });
});
