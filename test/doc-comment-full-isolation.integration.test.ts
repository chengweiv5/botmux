import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,realpathSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import{describe,it,expect}from'vitest';
import{verifyLinuxFullIsolation,docCommentFullIsolationVerified,daemonCommentIsolationPaths}from'../src/core/doc-comment-full-isolation.js';
import{linuxIsolationLaunch}from'../src/core/linux-isolation.js';
import{readProcessStartIdentity}from'../src/utils/process-identity.js';
import{tsEvalArgs,spawnTsScript}from'./helpers/ts-runner.js';
import{config}from'../src/config.js';
import{PtyBackend}from'../src/adapters/backend/pty-backend.js';
import{TmuxPipeBackend}from'../src/adapters/backend/tmux-pipe-backend.js';
import{createTmuxFence,applyTmuxFenceEnv,teardownTmuxFence}from'./helpers/tmux-fence.js';

const usable=process.platform==='linux'&&spawnSync('bwrap',['--ro-bind','/','/','--unshare-user','--unshare-pid','--proc','/proc','/bin/true'],{stdio:'ignore',timeout:5000}).status===0;
describe('actual comment full filesystem proof',()=>{
  it.runIf(usable)('publishes full isolation from a real worker private IPC for a cold fake Pi',async()=>{
    const dir=realpathSync(mkdtempSync('/tmp/comment-full-worker-')),previous=config.session.dataDir,previousHome=process.env.HOME;
    const data=join(dir,'data'),work=join(dir,'work'),bin=join(dir,'bin');
    for(const path of [data,work,bin])mkdirSync(path);
    const fake=join(bin,'pi');writeFileSync(fake,"#!/usr/bin/env node\nsetInterval(()=>process.stdout.write('pi> '),200);process.stdin.resume();",{mode:0o755});
    const worker=spawnTsScript(join(process.cwd(),'src/worker.ts'),[],{cwd:process.cwd(),env:{
      PATH:'/usr/bin:/bin',HOME:dir,SESSION_DATA_DIR:data,BOTMUX_SESSION_ID:'full-worker',LARK_APP_ID:'cli_full',LARK_APP_SECRET:'mock-only',
    },stdio:['ignore','pipe','pipe','ipc']});
    const messages:any[]=[];let logs='';worker.on('message',m=>messages.push(m));worker.stdout!.on('data',b=>logs+=b);worker.stderr!.on('data',b=>logs+=b);
    config.session.dataDir=data;process.env.HOME=dir;
    try{
      worker.send({type:'init',sessionId:'full-worker',chatId:'oc_fake',rootMessageId:'om_fake',workingDir:work,
        cliId:'pi',cliPathOverride:fake,backendType:'pty',prompt:'',larkAppId:'cli_full',larkAppSecret:'mock-only',sandbox:true,larkToolBinding:false});
      const end=Date.now()+20000;while(!messages.some(m=>m.type==='local_process_attestation'&&m.commentFullIsolation)
        &&Date.now()<end&&worker.exitCode===null)await new Promise(r=>setTimeout(r,25));
      const full=messages.find(m=>m.type==='local_process_attestation'&&m.commentFullIsolation);
      expect(full,logs).toBeDefined();
      const ds:any={worker,workerGeneration:1,session:{workerGeneration:1,sandbox:true},localProcessAttestation:{...full,workerGeneration:1}};
      expect(docCommentFullIsolationVerified(ds),JSON.stringify({full,expected:daemonCommentIsolationPaths(),kernel:verifyLinuxFullIsolation(full.cliPid,full.commentFullIsolation)})).toBe(true);
    }finally{
      if(worker.exitCode===null){const exit=new Promise(r=>worker.once('exit',r));worker.kill('SIGTERM');await exit;}
      config.session.dataDir=previous;process.env.HOME=previousHome;rmSync(dir,{recursive:true,force:true});
    }
  },30000);
  it.runIf(usable).each(['pty','tmux'] as const)('observes real %s full sandbox execution roots and readonly host directories',async mode=>{
    const dir=mkdtempSync('/tmp/comment-full-backend-'),previous=config.session.dataDir,previousTmux=process.env.TMUX_TMPDIR;
    const fence=createTmuxFence();applyTmuxFenceEnv(fence);
    const authority=join(dir,'doc-comment-negative'),empty=join(dir,'empty');mkdirSync(authority);mkdirSync(empty);chmodSync(empty,0o000);
    for(const name of ['oauth-pending','bytedcli-home'])mkdirSync(join(dir,name));
    const code=realpathSync(process.cwd()),deps=realpathSync(join(code,'node_modules'));
    const proof={mode:'full' as const,codeRoots:[code,deps],authorityRoot:authority};
    const payload=tsEvalArgs(`setInterval(()=>process.stdout.write('FULL_READY\\n'),200);process.stdin.once('data',()=>process.exit(0));`);
    const launch=linuxIsolationLaunch('/usr/bin/bwrap',['--tmpfs','/','--proc','/proc','--dev','/dev','--ro-bind','/usr','/usr',
      ...['/bin','/lib','/lib64'].filter(existsSync).flatMap(p=>['--ro-bind',realpathSync(p),p]),
      '--ro-bind',code,code,'--ro-bind',deps,deps,'--tmpfs',dir,'--ro-bind',empty,authority,
      '--ro-bind',empty,join(dir,'oauth-pending'),'--ro-bind',empty,join(dir,'bytedcli-home'),
      '--ro-bind',empty,join(dir,'..','.dashboard-secret'),
      '--unshare-user','--unshare-pid','--',payload.command,...payload.args]);
    const name='bmx-comment-full-'+Date.now();
    const backend=mode==='pty'?new PtyBackend():new TmuxPipeBackend(name,{createSession:true,ownsSession:true,socketName:'comment-full-test'});
    let out='';config.session.dataDir=dir;
    try{
      backend.spawn(launch.bin,launch.args,{cwd:dir,cols:80,rows:24,env:{...process.env} as Record<string,string>,launchShell:'/bin/bash'});
      backend.onData(b=>out+=b);
      const limit=Date.now()+10000;while(!out.includes('FULL_READY')&&Date.now()<limit)await new Promise(r=>setTimeout(r,20));
      const capture=mode==='tmux'?spawnSync('tmux',['-L','comment-full-test','capture-pane','-p','-t',name],{encoding:'utf8',env:{...process.env}}):undefined;
      expect(out,`${capture?.stdout??''}${capture?.stderr??''}`).toContain('FULL_READY');
      const {collectSessionLineagePids}=await import('../src/core/preview-port-owner.js');
      const pids=collectSessionLineagePids('/proc',[backend.getChildPid()!]);
      const cli=[...(pids??[])].find(p=>verifyLinuxFullIsolation(p,proof));expect(cli).toBeDefined();
      const ds:any={worker:{pid:process.pid,killed:false},workerGeneration:1,session:{workerGeneration:1,sandbox:true},localProcessAttestation:{backendType:mode,workerGeneration:1,cliPid:cli,cliProcStart:readProcessStartIdentity(cli!),commentFullIsolation:proof}};
      expect(docCommentFullIsolationVerified(ds)).toBe(true);
      for(const sandbox of [false,'off',undefined,'scratch']){
        ds.session.sandbox=sandbox;expect(docCommentFullIsolationVerified(ds)).toBe(false);
      }
      ds.session.sandbox=true;
      const invalid={...proof,codeRoots:[dir]};expect(verifyLinuxFullIsolation(cli!,invalid)).toBe(false);
      backend.write('end\n');
    }finally{backend.kill();if(mode==='tmux')spawnSync('tmux',['-L','comment-full-test','kill-session','-t',name],{env:{...process.env},stdio:'ignore'});teardownTmuxFence(fence);process.env.TMUX_TMPDIR=previousTmux;config.session.dataDir=previous;chmodSync(empty,0o700);rmSync(dir,{recursive:true,force:true});}
  },30000);
  it.runIf(usable).each([false,true])('distinguishes full isolation and rejects even readonly live token parents (exposed=%s)',async exposed=>{
    const dir=mkdtempSync('/tmp/comment-full-kernel-');let child:ChildProcess|undefined;const previous=config.session.dataDir;
    try{
      const data=join(dir,'data'),authority=join(data,'doc-comment-negative'),empty=join(dir,'empty');
      mkdirSync(authority,{recursive:true});mkdirSync(empty);chmodSync(empty,0o000);
      for(const name of ['oauth-pending','bytedcli-home'])mkdirSync(join(data,name));
      config.session.dataDir=data;
      const code=realpathSync(process.cwd()),deps=realpathSync(join(code,'node_modules'));
      const run=tsEvalArgs(`process.stdout.write('READY\\n');process.stdin.once('data',()=>process.exit(0));`);
      const mounts=['--tmpfs','/','--proc','/proc','--dev','/dev','--ro-bind','/usr','/usr',
        ...['/bin','/lib','/lib64'].filter(existsSync).flatMap(p=>['--ro-bind',realpathSync(p),p]),
        '--ro-bind',code,code,'--ro-bind',deps,deps,'--bind',dir,dir,...(exposed?['--ro-bind',data,data]:['--tmpfs',data]),'--ro-bind',empty,authority,
        '--ro-bind',empty,join(data,'oauth-pending'),'--ro-bind',empty,join(data,'bytedcli-home'),
        '--ro-bind',empty,join(dir,'.dashboard-secret'),
        '--unshare-user','--unshare-pid','--',run.command,...run.args];
      const launch=linuxIsolationLaunch('/usr/bin/bwrap',mounts);
      child=spawn(launch.bin,launch.args,{stdio:['pipe','pipe','pipe']});let out='',err='';
      child.stdout!.on('data',b=>out+=b);child.stderr!.on('data',b=>err+=b);
      const ended=new Promise<void>(r=>child!.once('exit',()=>r()));
      const limit=Date.now()+5000;while(!out.includes('READY')&&Date.now()<limit&&child.exitCode===null)await new Promise(r=>setTimeout(r,10));
      expect(out,err).toContain('READY');
      // linuxIsolationLaunch execs sh->bwrap; resolve the actual PID visible to host.
      const rootPid=child.pid!;
      const {collectSessionLineagePids}=await import('../src/core/preview-port-owner.js');
      const pids=collectSessionLineagePids('/proc',[rootPid]);
      const proof={mode:'full' as const,codeRoots:[code,deps],authorityRoot:authority};
      const cli=[...(pids??[])].find(p=>verifyLinuxFullIsolation(p,proof));
      if(exposed){expect(cli).toBeUndefined();child.stdin!.end('done');await ended;return;}
      expect(cli).toBeDefined();
      expect(verifyLinuxFullIsolation(process.pid,proof)).toBe(false);
      const ds:any={worker:{pid:process.pid,killed:false},workerGeneration:1,session:{workerGeneration:1,sandbox:true},
        localProcessAttestation:{workerGeneration:1,backendType:'pty',cliPid:cli,cliProcStart:readProcessStartIdentity(cli!),commentFullIsolation:proof}};
      expect(docCommentFullIsolationVerified(ds)).toBe(true);
      ds.localProcessAttestation.backendType='tmux';expect(docCommentFullIsolationVerified(ds)).toBe(true);
      ds.adoptedFrom='unproved-pane';expect(docCommentFullIsolationVerified(ds)).toBe(false);
      delete ds.adoptedFrom;ds.workerGeneration++;expect(docCommentFullIsolationVerified(ds)).toBe(false);
      child.stdin!.end('done');await ended;
    }finally{config.session.dataDir=previous;if(child?.exitCode===null){const ended=new Promise(r=>child!.once('exit',r));child.kill('SIGKILL');await ended;}chmodSync(join(dir,'empty'),0o700);rmSync(dir,{recursive:true,force:true});}
  });
});
