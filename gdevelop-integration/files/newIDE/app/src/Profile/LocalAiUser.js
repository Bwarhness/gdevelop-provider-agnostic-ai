// @flow
// Local AI provider support (Phase 1 of the provider-agnostic AI work).
//
// When the app is built/started with REACT_APP_LOCAL_AI=true, GDevelop's "Ask AI"
// feature is routed to a local OpenAI-compatible proxy (see
// REACT_APP_GENERATION_API_URL and ../Utils/GDevelopServices/ApiConfigs.js).
// That feature is gated behind a logged-in GDevelop account: every send path
// early-returns when `profile` is falsy and calls `getAuthorizationHeader()`.
// To use the local provider WITHOUT a real GDevelop cloud account, we present a
// synthetic authenticated user to the React tree. We override only the outgoing
// AuthenticatedUserContext value — the provider's internal state stays logged-out,
// so it never attempts real authenticated cloud fetches. `limits` is left null so
// the credit/quota gate is skipped (requests are sent as free).

export const isLocalAiEnabled = (): boolean =>
  !!process.env.REACT_APP_LOCAL_AI &&
  process.env.REACT_APP_LOCAL_AI !== 'false' &&
  process.env.REACT_APP_LOCAL_AI !== '0';

// Which mode the local provider runs in. 'chat' (Phase 1, default) is plain Q&A;
// 'agent' (Phase 3) lets the model call EditorFunctions tools to edit the project.
// 'orchestrator' (Phase 4, sub-agents) is not implemented locally — treated as agent.
export const getLocalAiMode = (): 'chat' | 'agent' | 'orchestrator' => {
  const m = (process.env.REACT_APP_LOCAL_AI_MODE || 'chat').toLowerCase();
  return m === 'agent' || m === 'orchestrator' ? m : 'chat';
};

// A minimal Profile-shaped object. Only `id` is load-bearing (it becomes the
// `userId` sent to the generation API); the rest keeps profile-reading UI happy.
const localAiProfile = {
  id: 'local-ai-user',
  email: 'local-ai@localhost',
  username: 'Local AI',
  description: null,
  getGameStatsEmail: false,
  getNewsletterEmail: false,
  isCreator: true,
  isPlayer: false,
  createdAt: 0,
  updatedAt: 0,
  appLanguage: 'en',
  donateLink: null,
  discordUsername: null,
  communityLinks: {},
  survey: null,
};

// A fully-permissive `limits` object. The real GDevelop cloud derives a user's
// capabilities/quotas from their subscription; with the local provider there is no
// subscription, so we present the most generous capability set. This satisfies every
// `limits.capabilities.*` gate at once (leaderboard theming/CSS/login-toggle, multiplayer
// player count UI, version-history flags, etc.) and makes capability caps "unlimited"
// (-1 is the codebase's unlimited sentinel).
//
// Deliberately omitted keys:
//  - `classrooms`: all its flags are *hide* flags for student accounts; omitting it keeps
//    everything visible (the one *show* flag gates a cloud-only tab, correctly left off).
//  - `privateTutorials`: gates GDevelop-hosted content that isn't available offline.
//
// IMPORTANT: keep `quotas: {}` and `prices: {}` (no `consumed-ai-credits` quota). The free
// "Ask AI" send path depends on the AI-credits quota lookup being absent (so it never reads
// as limit-reached). Adding a consumed-ai-credits quota here would re-introduce the AI block.
const localAiLimits = {
  capabilities: {
    analytics: {
      sessions: true,
      players: true,
      retention: true,
      sessionsTimeStats: true,
      platforms: true,
    },
    cloudProjects: {
      maximumCount: -1,
      canMaximumCountBeIncreased: false,
      maximumGuestCollaboratorsPerProject: -1,
    },
    leaderboards: {
      maximumCountPerGame: -1,
      canMaximumCountPerGameBeIncreased: false,
      themeCustomizationCapabilities: 'FULL',
      canUseCustomCss: true,
      canDisableLoginInLeaderboard: true,
    },
    multiplayer: {
      lobbiesCount: -1,
      maxPlayersPerLobby: 8,
      themeCustomizationCapabilities: 'FULL',
    },
    versionHistory: { enabled: true, retentionDays: -1 },
    ai: { availablePresets: [], versionHistory: { retentionDays: -1 } },
  },
  quotas: {},
  credits: {
    userBalance: { amount: 1000000 },
    prices: {},
    purchasableQuantities: {},
  },
  message: undefined,
};

// A synthetic subscription so subscription-gated client features unlock and no "manage
// subscription / upgrade" buttons (which would hit the cloud) are shown:
//  - planId set            => hasValidSubscriptionPlan() true
//  - 'gdevelop_startup'    => canUpgradeSubscription() false (top tier)
//  - 'MANUALLY_ADDED'      => hasSubscriptionBeenManuallyAdded() true (hides portal redirect)
const localAiSubscription = {
  userId: 'local-ai-user',
  planId: 'gdevelop_startup',
  pricingSystemId: 'MANUALLY_ADDED',
  createdAt: 0,
  updatedAt: 0,
};

// Applied to the AuthenticatedUserContext value before it is provided. If a real
// user is already authenticated, it is left untouched.
//
// We intentionally provide `profile` + `getAuthorizationHeader` but keep
// `authenticated: false` and `firebaseUser: null`. The "Ask AI" feature gates only
// on `profile` (e.g. AskAiEditorContainer `if (!profile)`), so this is enough to
// enable it. Meanwhile cloud features (game list, custom auth token, etc.) gate on
// `authenticated && firebaseUser` and stay dormant — so faking the AI user does NOT
// trigger doomed authenticated calls to the real GDevelop API (which would surface
// as uncaught network errors / the dev error overlay).
//
// We also inject permissive `limits` + a synthetic `subscription` so the premium gates
// that are purely client-side unlock. The provider's own fetch effects key off its
// internal (logged-out) state and only run when `firebaseUser` is set, so these injected
// objects are never overwritten and never trigger cloud calls.
export const applyLocalAiUserOverride = (base: any): any => {
  if (!isLocalAiEnabled()) return base;
  if (base && base.authenticated && base.profile) return base;
  return {
    ...base,
    authenticated: false,
    firebaseUser: null,
    loginState: 'done',
    profile: localAiProfile,
    limits: localAiLimits,
    subscription: localAiSubscription,
    getAuthorizationHeader: async () => 'Bearer local-ai-dev',
  };
};
