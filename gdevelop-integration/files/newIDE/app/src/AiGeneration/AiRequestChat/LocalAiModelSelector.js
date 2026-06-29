// @flow
// Local-AI-only: a model picker shown in the Ask AI chat footer (next to the reasoning
// level selector). It lists the OpenAI-compatible models the local oh-my-pi proxy knows
// about (GET <proxy>/omp-models) and switches the running proxy's active model/provider
// (POST <proxy>/config) — no app restart needed. Renders nothing unless local AI is on.
import * as React from 'react';
import { Trans } from '@lingui/macro';
import ButtonBase from '@material-ui/core/ButtonBase';
import Menu from '@material-ui/core/Menu';
import MenuItem from '@material-ui/core/MenuItem';
import ListSubheader from '@material-ui/core/ListSubheader';
import Tooltip from '@material-ui/core/Tooltip';
import Paper from '../../UI/Paper';
import ChevronArrowBottom from '../../UI/CustomSvgIcons/ChevronArrowBottom';
import { tooltipEnterDelay } from '../../UI/Tooltip';
import { isLocalAiEnabled } from '../../Profile/LocalAiUser';
import { GDevelopGenerationApi } from '../../Utils/GDevelopServices/ApiConfigs';

const PROXY = GDevelopGenerationApi.baseUrl;
const LOCAL_PROVIDERS = ['ollama', 'llama.cpp', 'lm-studio'];

// Map a model's oh-my-pi provider to the proxy auth source + any required headers.
const authSourceForProvider = (provider: string): string =>
  provider === 'kimi-code'
    ? 'omp-kimi'
    : LOCAL_PROVIDERS.includes(provider)
    ? ''
    : `omp:${provider}`;
const headersForProvider = (provider: string): Object =>
  provider === 'kimi-code'
    ? { 'User-Agent': 'KimiCLI/1.0', 'X-Msh-Platform': 'kimi_cli' }
    : {};

const styles = {
  paper: { borderRadius: 8, display: 'flex' },
  button: { padding: '4px 4px 4px 8px', display: 'flex', alignItems: 'center' },
  label: {
    fontSize: 13,
    fontFamily: 'var(--gdevelop-modern-font-family)',
    whiteSpace: 'nowrap',
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    margin: '0 4px',
  },
  chevronIcon: { fontSize: 20 },
  subheader: { lineHeight: '20px', paddingTop: 4, paddingBottom: 4 },
  menuItemContent: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: 16,
  },
  check: { fontSize: 13, opacity: 0.7 },
};

type Model = {
  provider: string,
  id: string,
  name: string,
  baseUrl: string,
  reasoning?: boolean,
  hasCredential?: boolean,
};

type Props = {| disabled?: boolean |};

export const LocalAiModelSelector = ({ disabled }: Props): React.Node => {
  const [models, setModels] = React.useState<Array<Model>>([]);
  const [current, setCurrent] = React.useState<?{ baseUrl: string, model: string }>(
    null
  );
  const [anchorEl, setAnchorEl] = React.useState(null);
  const [switching, setSwitching] = React.useState(false);
  const isMenuOpen = Boolean(anchorEl);

  React.useEffect(() => {
    if (!isLocalAiEnabled()) return;
    let cancelled = false;
    (async () => {
      try {
        const [modelsRes, configRes] = await Promise.all([
          fetch(`${PROXY}/omp-models`)
            .then(r => r.json())
            .catch(() => ({ models: [] })),
          fetch(`${PROXY}/config`)
            .then(r => r.json())
            .catch(() => null),
        ]);
        if (cancelled) return;
        const all: Array<Model> = (modelsRes && modelsRes.models) || [];
        // Only offer usable models: ones with a credential on file, or local servers.
        setModels(
          all.filter(m => m.hasCredential || LOCAL_PROVIDERS.includes(m.provider))
        );
        if (configRes)
          setCurrent({ baseUrl: configRes.baseUrl, model: configRes.model });
      } catch (e) {
        // Proxy not reachable / not the local proxy — leave the selector empty (hidden).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isLocalAiEnabled() || models.length === 0) return null;

  const currentModelId = current && current.model;
  const currentModel = models.find(
    m =>
      m.id === currentModelId &&
      (!current || !current.baseUrl || m.baseUrl === current.baseUrl)
  );
  const currentLabel = currentModel
    ? currentModel.name || currentModel.id
    : currentModelId || 'Model';

  const selectModel = async (m: Model) => {
    setAnchorEl(null);
    setSwitching(true);
    try {
      const res = await fetch(`${PROXY}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: m.baseUrl,
          model: m.id,
          authSource: authSourceForProvider(m.provider),
          extraHeaders: headersForProvider(m.provider),
        }),
      });
      const config = await res.json();
      setCurrent({ baseUrl: config.baseUrl, model: config.model });
    } catch (e) {
      // ignore — proxy will keep its previous model
    } finally {
      setSwitching(false);
    }
  };

  // Group models by provider for the menu.
  const providers = [];
  const byProvider: { [string]: Array<Model> } = {};
  for (const m of models) {
    if (!byProvider[m.provider]) {
      byProvider[m.provider] = [];
      providers.push(m.provider);
    }
    byProvider[m.provider].push(m);
  }

  return (
    <>
      <Paper
        background="light"
        style={{ ...styles.paper, opacity: disabled || switching ? 0.5 : 1 }}
      >
        <Tooltip title={<Trans>AI model</Trans>} enterDelay={tooltipEnterDelay}>
          <span>
            <ButtonBase
              onClick={e => setAnchorEl(e.currentTarget)}
              disabled={disabled || switching}
              style={styles.button}
            >
              <span style={styles.label}>{currentLabel}</span>
              <ChevronArrowBottom style={styles.chevronIcon} />
            </ButtonBase>
          </span>
        </Tooltip>
      </Paper>
      <Menu
        anchorEl={anchorEl}
        open={isMenuOpen}
        onClose={() => setAnchorEl(null)}
        MenuListProps={{ dense: true }}
      >
        <ListSubheader disableSticky style={styles.subheader}>
          <Trans>AI model:</Trans>
        </ListSubheader>
        {providers.map(provider => [
          <ListSubheader key={`h-${provider}`} disableSticky style={styles.subheader}>
            {provider}
          </ListSubheader>,
          ...byProvider[provider].map(m => {
            const isCurrent =
              m.id === currentModelId &&
              (!current || !current.baseUrl || m.baseUrl === current.baseUrl);
            return (
              <MenuItem
                key={`${provider}-${m.id}`}
                selected={isCurrent}
                onClick={() => selectModel(m)}
              >
                <div style={styles.menuItemContent}>
                  <span>
                    {m.name || m.id}
                    {m.reasoning ? ' · reasoning' : ''}
                  </span>
                  {isCurrent ? <span style={styles.check}>✓</span> : null}
                </div>
              </MenuItem>
            );
          }),
        ])}
      </Menu>
    </>
  );
};
