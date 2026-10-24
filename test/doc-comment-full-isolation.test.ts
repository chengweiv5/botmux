import {describe,it,expect} from 'vitest';
import {docCommentFullIsolationVerified} from '../src/core/doc-comment-full-isolation.js';

describe('comment full-only authority',()=>{
  it('refuses host and credential-only processes even with a claimed full mode',()=>{
    const ds:any={worker:{pid:process.pid,killed:false},workerGeneration:1,session:{workerGeneration:1},
      localProcessAttestation:{workerGeneration:1,backendType:'pty',cliPid:process.pid,cliProcStart:'fake',credentialIsolated:true,
        commentFullIsolation:{mode:'full',codeRoots:[process.cwd()],authorityRoot:process.cwd()}}};
    expect(docCommentFullIsolationVerified(ds)).toBe(false);
    delete ds.localProcessAttestation.commentFullIsolation;expect(docCommentFullIsolationVerified(ds)).toBe(false);
  });
});
