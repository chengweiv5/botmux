import{spawn,spawnSync,type ChildProcess}from'node:child_process';
import{mkdtempSync,mkdirSync,realpathSync,chmodSync,rmSync,writeFileSync,readFileSync,existsSync,readlinkSync,lstatSync}from'node:fs';
import{join}from'node:path';
import{describe,it,expect,vi}from'vitest';
import{linuxIsolationLaunch}from'../src/core/linux-isolation.js';
import{verifyLinuxFullIsolation,docCommentFullIsolationVerified}from'../src/core/doc-comment-full-isolation.js';
import{readProcessStartIdentity}from'../src/utils/process-identity.js';
import{collectSessionLineagePids}from'../src/core/preview-port-owner.js';
import{snapshotProcessIdentities}from'../src/core/current-actor-attestation.js';
import{config}from'../src/config.js';
import{startIpcServer,setIpcAuthSecret}from'../src/core/dashboard-ipc-server.js';
import{prepareLarkToolEnv,larkToolBindingPath}from'../src/core/lark-tool-binding.js';
import{registerDocCommentTurn}from'../src/core/doc-comment-turn-provenance.js';
import*as wp from'../src/core/worker-pool.js';import*as bots from'../src/bot-registry.js';import*as tokens from'../src/utils/user-token.js';import*as identity from'../src/im/lark/identity-cache.js';
import{seedPersistedSessionRows}from'./helpers/session-store-disk.js';import{fakeLarkHelpScript}from'./helpers/lark-tool-help.js';
import{tsRunnerPrefix}from'./helpers/ts-runner.js';

const usable=process.platform==='linux'&&spawnSync('bwrap',['--ro-bind','/','/','--unshare-user','--unshare-pid','--proc','/proc','/bin/true'],{stdio:'ignore',timeout:5000}).status===0;
describe('comment full sandbox actual wrappers',()=>{
  it.runIf(usable)('rejects A old background wrappers after B becomes author and allows B new tools before rechecking await',async()=>{
    const dir=mkdtempSync('/tmp/comment-full-wrappers-'),previous=config.session.dataDir;let child:ChildProcess|undefined;let ipc:any;
    try{
      const data=join(dir,'data'),authority=join(data,'doc-comment-negative'),empty=join(dir,'empty'),relay=join(data,'relay');
      mkdirSync(authority,{recursive:true});mkdirSync(empty);mkdirSync(relay);chmodSync(empty,0o000);config.session.dataDir=data;
      for(const name of ['oauth-pending','bytedcli-home'])mkdirSync(join(data,name));
      const repo=realpathSync(process.cwd()),deps=realpathSync(join(repo,'node_modules'));
      const real=join(dir,'fake-lark');writeFileSync(real,'#!/usr/bin/env node\n'+fakeLarkHelpScript()+'process.stdout.write("ran-as-user");',{mode:0o755});
      const binding=prepareLarkToolEnv({env:{PATH:'/usr/bin:/bin'},dataDir:data,sessionId:'full-session',appId:'cli_full'});binding.realBinary=real;
      const ds:any={session:{sessionId:'full-session',larkAppId:'cli_full',status:'active',workerGeneration:1,sandbox:true},larkAppId:'cli_full',chatId:'oc_chat',worker:{pid:process.pid,killed:false},workerGeneration:1};
      vi.spyOn(wp,'findActiveBySessionId').mockImplementation(id=>id==='full-session'?ds:undefined);
      vi.spyOn(bots,'getBot').mockReturnValue({config:{larkAppId:'cli_full',larkAppSecret:'mock'}}as any);
      vi.spyOn(identity,'resolveVerifiedUserIdentity').mockResolvedValue({openId:'ou_B',type:'user'}as any);
      const token=vi.spyOn(tokens,'resolveUserToken').mockResolvedValue('MOCK_B');
      const poll=vi.fn(async()=>({status:'ready',token:'MOCK_OAUTH_B'}));
      const oauth=vi.spyOn(tokens,'requestUserAuthorization').mockResolvedValue({authUrl:'https://example.com/mock',scopes:['im:chat:read'],expiresIn:300,poll}as any);
      setIpcAuthSecret('mock-host');ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true});binding.ipcPort=ipc.port;
      writeFileSync(larkToolBindingPath(data,'full-session'),JSON.stringify(binding),{mode:0o600});
      seedPersistedSessionRows(data,'cli_full',{'full-session':{...ds.session,chatId:'oc_chat',rootMessageId:'om_root',title:'mock',createdAt:new Date().toISOString()}});
      writeFileSync(join(data,'bots.json'),JSON.stringify([{larkAppId:'cli_full',larkAppSecret:'mock',cliId:'codex'}]));
      const runner=tsRunnerPrefix();
      const launch=linuxIsolationLaunch('/usr/bin/bwrap',['--tmpfs','/','--proc','/proc','--dev','/dev','--ro-bind','/usr','/usr',
        ...(lstatSync('/home').isSymbolicLink()?['--symlink',readlinkSync('/home'),'/home']:[]),
        ...(lstatSync('/home/yangchengwei.1').isSymbolicLink()?['--symlink',readlinkSync('/home/yangchengwei.1'),'/home/yangchengwei.1']:[]),
        ...['/bin','/lib','/lib64'].filter(existsSync).flatMap(p=>['--ro-bind',realpathSync(p),p]),
        '--ro-bind',realpathSync(join(repo,'..')),realpathSync(join(repo,'..')),'--ro-bind',deps,deps,'--bind',dir,dir,'--tmpfs',data,
        '--ro-bind',join(data,'cli-identity'),join(data,'cli-identity'),'--ro-bind',join(data,'session-stores'),join(data,'session-stores'),
        '--ro-bind',join(data,'bots.json'),join(data,'bots.json'),'--bind',relay,relay,'--ro-bind',empty,authority,
        '--ro-bind',empty,join(data,'oauth-pending'),'--ro-bind',empty,join(data,'bytedcli-home'),
        '--ro-bind',empty,join(dir,'.dashboard-secret'),
        '--unshare-user','--unshare-pid','--chdir',repo,'--',runner.command,...runner.prefixArgs,'test/fixtures/comment-full-wrapper-controller.ts']);
      child=spawn(launch.bin,launch.args,{stdio:['pipe','pipe','pipe']});let output='',err='';child.stdout!.on('data',b=>output+=b);child.stderr!.on('data',b=>err+=b);
      const wait=async(check:()=>boolean)=>{const end=Date.now()+15000;while(!check()&&Date.now()<end&&child!.exitCode===null)await new Promise(r=>setTimeout(r,10));expect(check(),err+'\n'+output).toBe(true)};
      await wait(()=>output.includes('OLD_READY'));
      const proof={mode:'full' as const,codeRoots:[repo,deps],authorityRoot:authority};
      const pids=[...(collectSessionLineagePids('/proc',[child.pid!])??[])];
      const cli=pids.find(p=>{try{return /\/(node|bun)$/.test(readlinkSync(`/proc/${p}/exe`))
        && !readFileSync(`/proc/${p}/cmdline`,'utf8').split('\0').includes('old')
        && readFileSync(`/proc/${p}/cmdline`,'utf8').includes('comment-full-wrapper-controller.ts')&&verifyLinuxFullIsolation(p,proof)}catch{return false}})!;
      expect(cli).toBeDefined();ds.localProcessAttestation={backendType:'pty',workerGeneration:1,cliPid:cli,cliProcStart:readProcessStartIdentity(cli),commentFullIsolation:proof};
      expect(docCommentFullIsolationVerified(ds)).toBe(true);
      const target={fileToken:'file',fileType:'docx',commentId:'c',replyId:'80021',turnId:'80021'};ds.session.docCommentTargets={'80021':target};registerDocCommentTurn(ds,{...target,workerGeneration:1,authorOpenId:'ou_B'});
      ds.managedTurnOrigin={turnId:'80021',capability:'ab'.repeat(32),originChannelId:'cd'.repeat(32),callerOpenId:'ou_B',preexistingProcessIdentities:snapshotProcessIdentities(cli)};
      writeFileSync(join(relay,'.botmux-origin-capability.json'),JSON.stringify({sessionId:'full-session',larkAppId:'cli_full',turnId:'80021',capability:ds.managedTurnOrigin.capability,channelId:ds.managedTurnOrigin.originChannelId}),{mode:0o600});
      const call=async(old:boolean,auth=false,requestId?:string)=>{const n=output.split('\n').length;child!.stdin!.write(JSON.stringify({old,auth,requestId,repo,data,relay,port:ipc.port,binding:larkToolBindingPath(data,'full-session')})+'\n');await wait(()=>output.split('\n').length>n);return JSON.parse(output.trim().split('\n').at(-1)!)};
      const denied=await call(true);expect(denied.code,denied.err).toBe(77);expect(token).not.toHaveBeenCalled();
      const deniedAuth=await call(true,true);expect(deniedAuth.code).not.toBe(0);expect(oauth).not.toHaveBeenCalled();
      const fresh=await call(false);expect(fresh.code,fresh.err).toBe(0);expect(token).toHaveBeenCalledExactlyOnceWith('cli_full','mock','feishu','ou_B');
      const auth=await call(false,true);expect(auth.code,auth.err).toBe(0);expect(oauth).toHaveBeenCalledTimes(1);
      const requestId=JSON.parse(auth.out.trim()).requestId;
      // Accepted OAuth has an independent daemon poll. Let that authorized
      // poll complete before counting calls caused by the stale HTTP request.
      await wait(()=>poll.mock.calls.length>0);
      const before=poll.mock.calls.length;
      const staleStatus=await call(true,true,requestId);expect(staleStatus.code).not.toBe(0);
      expect(JSON.parse(staleStatus.out.trim())).toMatchObject({ok:false,error:'current_actor_unverified'});
      expect(poll.mock.calls.length).toBe(before);
      const freshStatus=await call(false,true,requestId);expect(freshStatus.code,freshStatus.err).toBe(0);
      expect(JSON.parse(freshStatus.out.trim())).toEqual({ok:true,status:'ready'});
      token.mockImplementation(async()=>{ds.managedTurnOrigin.capability='rotated';return'LATE_SECRET'});
      const late=await call(false);expect(late.code).toBe(77);expect(late.out+late.err).not.toContain('LATE_SECRET');
    }finally{
      if(child?.exitCode===null){const exited=new Promise(r=>child!.once('exit',r));child.stdin!.end();await exited;}
      await ipc?.close();setIpcAuthSecret(null);vi.restoreAllMocks();config.session.dataDir=previous;chmodSync(join(dir,'empty'),0o700);rmSync(dir,{recursive:true,force:true});
    }
  },60000);
});
