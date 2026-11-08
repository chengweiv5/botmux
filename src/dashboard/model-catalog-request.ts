import type { BotConfig } from '../bot-registry.js';
import { config } from '../config.js';
import type { BackendType } from '../adapters/backend/types.js';
import { resolve } from 'node:path';
import { expandHomePath } from '../utils/working-dir.js';
import { unpinnedSessionWorkingDir } from '../core/working-dir-range.js';
import { larkTransportEnabled, type DaemonSession } from '../core/types.js';
import { resolveCliRuntime, runtimeInstallationKey, runtimePathOverride, type CliRuntimeSnapshot } from '../adapters/cli/runtime.js';
import { isRemoteBackendId, isRemoteCliId, resolvePairedBackendId } from '../core/remote-cli-ids.js';
import { RPC_CAPABLE_CLIS } from '../services/codex-rpc-input-policy.js';
import { botOneShotProbeEnv, sessionOneShotProbeEnv } from '../core/session-env-resolve.js';
import { protectedMcpCurrentRedactedEnvKeys } from '../core/protected-mcp-capabilities.js';
import { configuredProtectedMcpEnvKeys, readGlobalConfig } from '../global-config.js';
import { runtimeExecutableForBotSelection, type PersistedBotRuntimeSelection } from '../services/model-catalog.js';
import {
  lookupCliSelection,
  lookupCliSelectionForBotShape,
  resolveCliSelection,
} from '../setup/cli-selection.js';

export interface ModelCatalogProbeContext {
  selectionKey: string;
  canProbe: boolean;
  cliId: ReturnType<typeof resolveCliSelection>['cliId'];
  runtimeExecutable: string | undefined;
  runtimeContext: string | undefined;
  probeEnv: NodeJS.ProcessEnv | undefined;
  probeCwd: string | undefined;
  fingerprint: string | undefined;
}

type ProbeSession = Pick<DaemonSession, 'workingDir' | 'session' | 'adoptedFrom'>
  & Partial<Pick<DaemonSession, 'chatId' | 'initConfig'>>;
type SessionProbeSelection = Omit<PersistedBotRuntimeSelection, 'cliRuntime'> & { cliRuntime?: CliRuntimeSnapshot | null };

/** Read the worker's launch inputs without freezing, repairing or persisting a
 * session. A selected snapshot's null fields mean stock, not Bot inheritance. */
function sessionProbeSelection(session: ProbeSession, bot: BotConfig): SessionProbeSelection {
  const stored = session.session;
  const selected = stored.cliLaunchSnapshot;
  if (selected) {
    // The worker rejects these selections. Discovery must not bypass that gate.
    if (stored.codexProfile || selected.cliId === 'riff' || bot.riff !== undefined || bot.backendType === 'riff'
      || bot.env && Object.keys(bot.env).length > 0
      || bot.codexRpcInput === true && !RPC_CAPABLE_CLIS.has(selected.cliId)) throw new Error('unavailable CLI selection');
    if (selected.state !== 'resolved' && selected.state !== 'pending') throw new Error('unresolved CLI selection');
    const path = selected.cliPathOverride ?? undefined;
    if (selected.cliRuntime && runtimePathOverride(selected.cliRuntime) !== path) {
      // Incoherent forward/legacy fields cannot identify the worker's adapter
      // and runtime as one installation. Do not guess or repair from a menu.
      throw new Error('inconsistent selected runtime');
    }
    return { cliId: selected.cliId, cliRuntime: selected.cliRuntime,
      cliPathOverride: path, wrapperCli: selected.wrapperCli, cliLaunchMode: selected.cliLaunchMode };
  }
  const cliId = stored.cliId ?? bot.cliId;
  if (stored.agentFrozen) {
    const runtime = stored.cliRuntime ?? resolveCliRuntime({ cliId, cliPathOverride: stored.cliPathOverride });
    return { cliId, cliRuntime: runtime, cliPathOverride: runtimePathOverride(runtime),
      wrapperCli: stored.wrapperCli, cliLaunchMode: cliId === 'traex' ? stored.cliLaunchMode : undefined };
  }
  // Match the pre-freeze legacy backfill, including its own path taking priority
  // over a Bot descriptor. Never borrow a different CLI's executable or wrapper.
  if (cliId !== bot.cliId) {
    if (!stored.cliPathOverride || (!stored.wrapperCli && bot.wrapperCli)
      || (!stored.cliLaunchMode && bot.cliLaunchMode)) throw new Error('unresolved cross-CLI legacy runtime');
    const runtime = resolveCliRuntime({ cliId, cliPathOverride: stored.cliPathOverride });
    return { cliId, cliRuntime: runtime, cliPathOverride: stored.cliPathOverride,
      wrapperCli: stored.wrapperCli, cliLaunchMode: stored.cliLaunchMode };
  }
  const runtime = resolveCliRuntime({ cliId,
    cliRuntime: stored.cliPathOverride ? undefined : bot.cliRuntime,
    cliPathOverride: stored.cliPathOverride ?? (bot.cliRuntime ? undefined : bot.cliPathOverride) });
  return { cliId, cliRuntime: runtime,
    cliPathOverride: stored.cliPathOverride ?? runtimePathOverride(runtime) ?? bot.cliPathOverride,
    wrapperCli: stored.wrapperCli ?? bot.wrapperCli, cliLaunchMode: stored.cliLaunchMode ?? bot.cliLaunchMode };
}

/**
 * Session launch identity and live Bot defaults are separate inputs. Resolve
 * session identity read-only; env follows the session's existing launch policy.
 */
export function modelCatalogProbeContext(
  key: string,
  botConfig: BotConfig | undefined,
  baseEnv: NodeJS.ProcessEnv,
  session?: ProbeSession,
): ModelCatalogProbeContext {
  let selection = lookupCliSelection(key);
  let sessionRuntime: SessionProbeSelection | undefined;
  let canProbe = true;
  if (session && botConfig) {
    try {
      sessionRuntime = sessionProbeSelection(session, botConfig);
      selection = lookupCliSelectionForBotShape(sessionRuntime.cliId, sessionRuntime.wrapperCli, sessionRuntime.cliLaunchMode);
      canProbe = !!selection;
    } catch { canProbe = false; }
  }
  const selectionKey = selection?.key ?? key;
  const cliId = selection?.cliId ?? resolveCliSelection(key).cliId;
  // A live worker already has its backend. Cold launches pair the actual CLI
  // with stamp/Bot/daemon defaults before composing env, just as spawn does.
  const backendType = session?.initConfig?.backendType ?? (resolvePairedBackendId(
    cliId, session?.session.backendType ?? botConfig?.backendType, config.daemon.backendType,
  ) ?? 'pty') as BackendType;
  canProbe = canProbe && !isRemoteCliId(cliId) && !isRemoteBackendId(backendType);
  const requestedSelection = selection;
  const persistedSelection = botConfig
    ? lookupCliSelectionForBotShape(botConfig.cliId, botConfig.wrapperCli, botConfig.cliLaunchMode)
    : undefined;
  const runtimeApplies = botConfig !== undefined
    && requestedSelection !== undefined
    && persistedSelection?.key === requestedSelection.key;
  const runtimeExecutable = sessionRuntime
    ? runtimeExecutableForBotSelection(selectionKey, sessionRuntime)
    : runtimeApplies && !session
    ? runtimeExecutableForBotSelection(selectionKey, botConfig)
    : undefined;
  // Runtime freeze does not freeze env. Match the existing worker overlay:
  // only /cli selections and instance bindings skip Bot set; removals remain.
  const probe = session && botConfig
    ? sessionOneShotProbeEnv(baseEnv, {
      bot: botConfig, backendType,
      skipBotSet: !!(session.session.cliLaunchSnapshot || session.session.cliInstanceBinding),
      facts: { larkBindingOff: !larkTransportEnabled({ chatId: session.chatId, apiOnly: botConfig.apiOnly })
        || session.session.existingAppServerEndpoint !== undefined },
    }, { capabilities: [], protectedHomePaths: [], redactEnv: protectedMcpCurrentRedactedEnvKeys(
      readGlobalConfig().protectedMcpCapabilities, configuredProtectedMcpEnvKeys(),
    ) })
    : runtimeApplies ? botOneShotProbeEnv(baseEnv, { ...botConfig, backendType }) : undefined;
  // HOME is deliberately not persisted by the worker. Read its live launch
  // cwd first; cold sessions retain their pin. The existing unpinned rule also
  // excludes auto-worktree BASE directories. Never create or replace a gone cwd.
  const directory = session?.workingDir || session?.session.workingDir || session?.adoptedFrom?.cwd
    || (botConfig && (session || runtimeApplies) ? unpinnedSessionWorkingDir(botConfig) : undefined);
  // Expand with the daemon's HOME, as getSessionWorkingDir/worker do, not the
  // Bot's injected HOME (which is only an agent configuration input).
  const probeCwd = directory !== undefined ? resolve(expandHomePath(directory || '~')) : undefined;
  return {
    selectionKey,
    canProbe,
    cliId,
    runtimeExecutable,
    runtimeContext: sessionRuntime
      ? `${botConfig?.larkAppId}:${runtimeInstallationKey(sessionRuntime)}`
      : runtimeApplies
      ? `${botConfig.larkAppId}:${cliId}:${runtimeExecutable ?? 'default'}`
      : undefined,
    probeEnv: probe?.env,
    probeCwd,
    fingerprint: probe?.fingerprint,
  };
}
