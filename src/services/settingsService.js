import { supabase } from '../lib/supabase';
import { DEFAULT_GONE_QUIET_DAYS, DEFAULT_SLA } from '../utils/constants';

const DEFAULTS = {
  gonequietThresholdDays: DEFAULT_GONE_QUIET_DAYS,
  slaEscalationDays: DEFAULT_SLA.escalationDays,
  slaAccountsDays: DEFAULT_SLA.accountsDays,
  slaDispatchDays: DEFAULT_SLA.dispatchDays,
};

function rowToSettings(row) {
  if (!row) return DEFAULTS;
  return {
    gonequietThresholdDays: row.gone_quiet_threshold_days ?? DEFAULTS.gonequietThresholdDays,
    slaEscalationDays: row.sla_escalation_days ?? DEFAULTS.slaEscalationDays,
    slaAccountsDays: row.sla_accounts_days ?? DEFAULTS.slaAccountsDays,
    slaDispatchDays: row.sla_dispatch_days ?? DEFAULTS.slaDispatchDays,
  };
}

export async function getSettings() {
  const { data } = await supabase.from('settings').select('*').eq('id', 'app').maybeSingle();
  return rowToSettings(data);
}

let _settingsChannelCounter = 0;
export function subscribeToSettings(callback) {
  const initial = async () => {
    const { data } = await supabase.from('settings').select('*').eq('id', 'app').maybeSingle();
    callback(rowToSettings(data));
  };
  initial();
  _settingsChannelCounter += 1;
  const channel = supabase
    .channel(`public:settings:${_settingsChannelCounter}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, initial)
    .subscribe();
  return () => channel.unsubscribe();
}

export async function updateSettings(data) {
  // Map camelCase → snake_case
  const row = {
    id: 'app',
    gone_quiet_threshold_days: data.gonequietThresholdDays,
    sla_escalation_days: data.slaEscalationDays,
    sla_accounts_days: data.slaAccountsDays,
    sla_dispatch_days: data.slaDispatchDays,
  };
  const { error } = await supabase.from('settings').upsert(row);
  if (error) throw error;
}
