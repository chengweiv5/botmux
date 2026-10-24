import{spawn}from'node:child_process';
import{createInterface}from'node:readline';
import{spawnTsScript}from'../helpers/ts-runner.js';

const run=(input:any)=>new Promise(resolve=>{
  const path=input.auth?'src/cli.ts':'src/lark-tool-runner.ts';
  const args=input.requestId?['auth','wait','--request-id',input.requestId,'--json']
    :input.auth?['auth','request','--scope','im:chat:read','--json']:['--binding',input.binding,'--','docs','+fetch','--as','user'];
  const c=spawnTsScript(path,args,{cwd:input.repo,env:{...process.env,SESSION_DATA_DIR:input.data,
    BOTMUX_SESSION_ID:'full-session',BOTMUX_LARK_APP_ID:'cli_full',BOTMUX_DAEMON_IPC_PORT:String(input.port),BOTMUX_LARK_TOOL_BINDING:input.binding,
    BOTMUX_SEND_RELAY:input.relay,BOTS_CONFIG:input.data+'/bots.json'},stdio:['ignore','pipe','pipe']});
  let out='',err='';c.stdout!.on('data',b=>out+=b);c.stderr!.on('data',b=>err+=b);c.once('exit',code=>resolve({code,out,err}));
});
if(process.argv[2]==='old'){
  console.log('OLD_READY');createInterface({input:process.stdin}).on('line',async line=>{const x=JSON.parse(line);console.log(JSON.stringify(await run(x)));});
}else{
  const old=spawnTsScript(process.argv[1],['old'],{stdio:['pipe','pipe','pipe']});
  old.stdout!.pipe(process.stdout);old.stderr!.pipe(process.stderr);
  createInterface({input:process.stdin}).on('line',async line=>{
    const x=JSON.parse(line);if(x.old)old.stdin!.write(JSON.stringify(x)+'\n');
    else console.log(JSON.stringify(await run(x)));
  });
  process.stdin.once('end',()=>{old.kill('SIGKILL');process.exit(0)});
}
