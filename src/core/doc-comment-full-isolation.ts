import { readFileSync, readlinkSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { join, posix, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import type { DaemonSession } from './types.js';
import { readProcessStartIdentity } from '../utils/process-identity.js';

export interface CommentFullIsolation {
  mode: 'full'; codeRoots: string[]; authorityRoot: string;
}
const decode = (p: string) => p.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
const covers = (root: string, path: string) => path === root || path.startsWith(root === '/' ? '/' : root + '/');

/** Host kernel observation, never a child-provided path/PID authority. */
export function verifyLinuxFullIsolation(pid: number, proof: CommentFullIsolation): boolean {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 1
    || proof.mode !== 'full' || !proof.codeRoots.length || !proof.authorityRoot.startsWith('/')) return false;
  try {
    if (readlinkSync(`/proc/${pid}/ns/mnt`) === readlinkSync('/proc/self/ns/mnt')
      || readlinkSync(`/proc/${pid}/ns/pid`) === readlinkSync('/proc/self/ns/pid')) return false;
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    if (!/^NoNewPrivs:\s+1$/m.test(status) || !/^Seccomp:\s+2$/m.test(status)) return false;
    const parseMounts = (raw: string) => raw.trim().split('\n').map(line => {
      const [left, right] = line.split(' - '); const fields = left.split(' ');
      return { path: decode(fields[4]), root: decode(fields[3]), device:fields[2], ro: fields[5].split(',').includes('ro'), fs: right.split(' ')[0] };
    });
    const mounts=parseMounts(readFileSync(`/proc/${pid}/mountinfo`, 'utf8'));
    const hostMounts=parseMounts(readFileSync('/proc/self/mountinfo','utf8'));
    const enclosing = (path: string) => mounts.filter(m => covers(m.path, path)).sort((a,b) => b.path.length - a.path.length)[0];
    const writableAlias = (path:string) => {
      const host=hostMounts.filter(m=>covers(m.path,path)).sort((a,b)=>b.path.length-a.path.length)[0];
      if(!host)return true;
      const source=posix.join(host.root,posix.relative(host.path,path));
      return mounts.some(m=>{
        if(m.ro||m.device!==host.device)return false;
        if(covers(m.root,source)){
          const alias=posix.join(m.path,posix.relative(m.root,source));
          const visible=enclosing(alias);return !!visible&&!visible.ro&&visible.device===host.device;
        }
        return covers(source,m.root); // exposed writable subtree of protected source
      });
    };
    const readableHostAlias = (path: string, includeSubtrees = true) => {
      const host = hostMounts.filter(m => covers(m.path, path)).sort((a,b) => b.path.length-a.path.length)[0];
      if (!host) return true;
      const source = posix.join(host.root, posix.relative(host.path, path));
      return mounts.some(m => {
        if (m.device !== host.device) return false;
        if (covers(m.root, source)) {
          const alias = posix.join(m.path, posix.relative(m.root, source));
          const visible = enclosing(alias);
          return !!visible && visible.device === host.device
            && posix.join(visible.root,posix.relative(visible.path,alias)) === source;
        }
        return includeSubtrees && covers(source,m.root);
      });
    };
    // Credential-only binds host / RW. Full bwrap starts from a fresh root.
    if (enclosing('/')?.fs !== 'tmpfs') return false;
    for (const raw of proof.codeRoots) {
      const path = realpathSync(raw);
      if (path === '/' || writableAlias(path) || !enclosing(path)?.ro || mounts.some(m => covers(path,m.path) && !m.ro)) return false;
      const host = statSync(path), child = statSync(join(`/proc/${pid}/root`, path));
      if (host.dev !== child.dev || host.ino !== child.ino) return false;
    }
    const authority = realpathSync(proof.authorityRoot);
    if(writableAlias(authority))return false;
    const boundary = enclosing(authority);
    if (!boundary || (!boundary.ro && boundary.fs !== 'tmpfs')
      || mounts.some(m => covers(authority,m.path) && !m.ro && m.fs !== 'tmpfs')) return false;
    // Negative root is hidden, never a bind of the live authority directory.
    try {
      const host = statSync(authority), child = statSync(join(`/proc/${pid}/root`, authority));
      if (host.dev === child.dev && host.ino === child.ino) return false;
    } catch { /* inaccessible hidden authority is correct */ }
    // The token provider's host stores and siblings' raw credentials must not
    // be reachable through a broad workingDir/home bind or an alias mount.
    for (const tokenRoot of [...new Set([join(homedir(),'.botmux','data'),dirname(authority)])]) {
      const canonical=(path:string):string=>{try{return realpathSync(path)}catch{const parent=dirname(path);return parent===path?path:join(canonical(parent),posix.basename(path))}};
      const root=canonical(tokenRoot);
      // Never expose the live token parent, even readonly: future user-token
      // files must stay hidden. Exact session-owned submounts are independent.
      if (readableHostAlias(root,false)) return false;
      const protectedPaths=[join(root,'oauth-pending'),join(root,'bytedcli-home'),
        join(dirname(root),'.dashboard-secret')];
      try {for(const name of readdirSync(root))if(/^user-token(?:-|\.json)/.test(name))protectedPaths.push(join(root,name));}catch{}
      for(const path of protectedPaths){
        if(readableHostAlias(path))return false;
        const mount=enclosing(path);
        if(mount&&mount.fs!=='tmpfs'){
          try{const h=statSync(path),c=statSync(join(`/proc/${pid}/root`,path));if(h.dev===c.dev&&h.ino===c.ino)return false}catch{}
        }
      }
    }
    return true;
  } catch { return false; }
}

/** Derived by the trusted daemon; also used when verifying the actual HTTP
 * peer rather than only the long-lived CLI/engine roots. */
export function daemonCommentIsolationPaths(): CommentFullIsolation | undefined {
  try {
    const install=realpathSync(fileURLToPath(new URL('../..',import.meta.url)));
    const expected=[install];try{expected.push(realpathSync(join(install,'node_modules')))}catch{}
    return {mode:'full',codeRoots:[...new Set(expected)],authorityRoot:realpathSync(join(config.session.dataDir,'doc-comment-negative'))};
  }catch{return undefined;}
}

export function docCommentFullIsolationVerified(ds: DaemonSession): boolean {
  const attestation = ds.localProcessAttestation;
  const proof = attestation?.commentFullIsolation;
  if (!proof || ds.adoptedFrom || ds.initConfig?.adoptMode || !['pty','tmux'].includes(attestation!.backendType)
    || (ds.session.sandbox !== true && ds.session.sandbox !== 'oncall')
    || !ds.worker || ds.worker.killed || attestation?.workerGeneration !== ds.workerGeneration
    || ds.session.workerGeneration !== ds.workerGeneration) return false;
  // Paths are daemon-derived. Private worker IPC selects only full mode;
  // it cannot nominate an innocuous readonly directory instead of our code.
  try {
    const expected=daemonCommentIsolationPaths();
    if (!expected || proof.authorityRoot !== expected.authorityRoot
      || JSON.stringify(expected.codeRoots.sort()) !== JSON.stringify([...new Set(proof.codeRoots)].sort())) return false;
  } catch {return false;}
  const roots = [[attestation.cliPid,attestation.cliProcStart],[attestation.enginePid,attestation.engineProcStart]] as const;
  const present = roots.filter(([pid]) => pid !== undefined);
  return present.length > 0 && present.every(([pid,start]) => !!pid && !!start
    && readProcessStartIdentity(pid) === start && verifyLinuxFullIsolation(pid,proof));
}
