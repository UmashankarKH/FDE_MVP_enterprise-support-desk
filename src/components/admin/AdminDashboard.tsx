import React, { useState, useMemo, useEffect } from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { tokenRequest } from '../../authConfig';
import { Ticket, TicketStatus, TicketPriority, TicketChannel, ActivityEvent } from '../../types';
import { 
  LayoutDashboard, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  Star, 
  UserCheck, 
  Bot, 
  Search, 
  Filter, 
  ArrowUpRight, 
  MessageSquare, 
  Mail, 
  Phone, 
  Slack, 
  Send, 
  ShieldAlert, 
  BarChart3, 
  PieChart as PieChartIcon, 
  TrendingUp, 
  Activity, 
  Play, 
  Pause, 
  Sparkles,
  X,
  Zap,
  BookOpen,
  User,
  Check,
  Edit2
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  CartesianGrid
} from 'recharts';

const BACKEND_URL = import.meta.env.VITE_API_BASE_URL || 'https://fde-backend-api.thankfulsea-427101da.eastus.azurecontainerapps.io';

interface BackendStats {
  total_tickets: number;
  unique_users: number;
  resolved: number;
  escalated: number;
  not_resolved: number;
  resolution_rate_pct: number;
  by_channel: Record<string, number>;
}

// Mirrors resolution_cache.py's stats() shape exactly - real counters from
// the live backend process, not mocked. See GET /cache/stats in app.py.
interface CacheStats {
  enabled: boolean;
  entries: number;
  max_entries: number;
  ttl_seconds: number;
  min_rag_confidence: number;
  hits: number;
  misses: number;
  expired: number;
  hit_rate_pct: number;
  recent_events: { event: string; citation_id: string | null; at: number }[];
  // Question-level cache (skips Intake + Triage on exact repeat questions)
  question_cache?: {
    enabled: boolean;
    entries: number;
    hits: number;
    misses: number;
    hit_rate_pct: number;
  };
}

function formatRelative(iso?: string): string {
  if (!iso) return 'Unknown';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Unknown';
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const BACKEND_STATUS_MAP: Record<string, TicketStatus> = {
  intake: 'Open',
  triaged: 'In Progress',
  rag_lookup: 'In Progress',
  resolving: 'In Progress',
  critic_review: 'In Progress',
  action_taken: 'In Progress',
  pending_human_approval: 'Pending Approval',
  auto_resolved: 'Resolved',
  closed: 'Resolved',
  escalated: 'Escalated',
};

const AGENT_LABEL_MAP: Record<string, string> = {
  intake: 'Intake Agent',
  triage: 'Triage Agent',
  policy_rag: 'RAG Agent',
  resolver: 'Resolver Agent',
  critic: 'Critic Agent',
  manager: 'Manager Agent',
  action: 'Action Agent',
  escalation: 'Escalation Agent',
};

// Converts a raw Cosmos DB ticket document (backend TicketState.to_cosmos_doc())
// into the richer frontend Ticket shape the existing UI was built against.
// The backend model is intentionally lean (no customer profile, no priority
// field) - those are synthesized here with sane defaults so live tickets
// render in the same table/cards as the demo's mock tickets.
function mapBackendTicket(doc: any): Ticket {
  const customerIdRaw: string = doc.customer_id || 'unknown';
  const isEmail = customerIdRaw.includes('@');
  const status = BACKEND_STATUS_MAP[doc.status] || 'Open';
  const priority: TicketPriority =
    status === 'Escalated' ? 'Urgent' : doc.request_type === 'incident' ? 'High' : 'Medium';

  return {
    id: doc.ticket_number || doc.ticketId || doc.id,
    backendTicketId: doc.ticketId || doc.id,
    subject: doc.category ? `${doc.category} — ${(doc.issue_text || '').slice(0, 40)}` : (doc.issue_text || 'Support request').slice(0, 60),
    description: doc.issue_text || '',
    category: doc.category || 'General',
    channel: (doc.channel || 'chat') as TicketChannel,
    priority,
    status,
    customer: {
      id: customerIdRaw,
      name: customerIdRaw,
      email: isEmail ? customerIdRaw : `${customerIdRaw}@unknown.local`,
      company: '—',
      tier: 'Starter',
      priorTicketsCount: 0,
    },
    assignedAgent: doc.requires_human
      ? doc.human_decision
        ? `Human Agent (${doc.human_decision})`
        : 'Pending Human Review'
      : 'AI Support Agent',
    createdTime: formatRelative(doc.created_at),
    lastUpdated: formatRelative(doc.updated_at),
    createdAtIso: doc.created_at,
    updatedAtIso: doc.updated_at,
    confidenceScore: doc.resolver_confidence != null ? Math.round(doc.resolver_confidence * 100) : undefined,
    aiDraftResponse: doc.draft_resolution || undefined,
    agentTrace: Array.isArray(doc.agent_trace)
      ? doc.agent_trace.map((entry: any) => ({
          agentName: (AGENT_LABEL_MAP[entry.agent] || entry.agent) as any,
          status: 'completed' as const,
          message: entry.summary || '',
          timestamp: entry.timestamp || '',
        }))
      : [],
    kbUsed: Array.isArray(doc.rag_citations) ? doc.rag_citations.map((c: any) => c.title).filter(Boolean) : [],
    backendActionTaken: doc.action_result?.proposed_action,
    conversationHistory: [],
  };
}

interface AdminDashboardProps {
  tickets: Ticket[];
  onUpdateTicket: (updatedTicket: Ticket) => void;
  activityLogs: ActivityEvent[];
  onAddActivityLog: (event: ActivityEvent) => void;
  onTriggerEmailToast: (recipient: string, subject: string, ticketId: string, status: string) => void;
}

// --- Teaching panel: KV cache size, simulated ---
// IMPORTANT: this is illustrative only. The KV cache lives entirely inside
// Azure OpenAI's own serving infrastructure - it is never exposed through
// the API, so there is no real setting here to control. This panel exists
// to make the formula from the curriculum's Segment A tangible on a slide,
// not to represent anything this app's live backend actually does. Say
// that out loud when demoing it - the honesty is the point.
const KV_QUANT_OPTIONS = [
  { label: 'fp16 / bf16', bytesPerParam: 2 },
  { label: 'int8', bytesPerParam: 1 },
  { label: 'int4', bytesPerParam: 0.5 },
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes.toFixed(0)} B`;
}

const KVCacheSimulator: React.FC = () => {
  // Stand-in architecture numbers for a representative 70B-class open-weight
  // model - gpt-4o's real layer/head counts aren't published by Azure.
  const [layers, setLayers] = useState(80);
  const [heads, setHeads] = useState(64);
  const [headDim, setHeadDim] = useState(128);
  const [seqLength, setSeqLength] = useState(8000);
  const [concurrency, setConcurrency] = useState(10);
  const [quantIdx, setQuantIdx] = useState(0);

  const bytesPerParam = KV_QUANT_OPTIONS[quantIdx].bytesPerParam;
  const perSequenceBytes = layers * 2 * heads * headDim * bytesPerParam * seqLength;
  const totalBytes = perSequenceBytes * concurrency;

  const Slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    display?: string,
  ) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>{label}</span>
        <span className="font-mono text-cyan-300">{display ?? value.toLocaleString()}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-cyan-500"
      />
    </div>
  );

  return (
    <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-bold text-white flex items-center space-x-2">
          <Zap className="w-4 h-4 text-amber-400" />
          <span>KV Cache Size — Simulated</span>
        </h3>
        <span className="text-[10px] uppercase tracking-wide bg-amber-500/10 text-amber-300 border border-amber-500/30 rounded-full px-2 py-0.5">
          Not live — teaching only
        </span>
      </div>
      <p className="text-xs text-slate-500 leading-relaxed">
        Illustrative — not connected to the real Azure OpenAI backend. The KV cache is entirely internal to the model-serving
        infrastructure and isn't exposed by the API. This exists to make the formula tangible, not to control anything real.
      </p>

      <div className="grid grid-cols-2 gap-4">
        {Slider('Layers', layers, 8, 120, 1, setLayers)}
        {Slider('Attention heads', heads, 8, 128, 1, setHeads)}
        {Slider('Head dimension', headDim, 32, 256, 8, setHeadDim)}
        {Slider('Sequence length (tokens)', seqLength, 500, 128000, 500, setSeqLength)}
        {Slider('Concurrent sequences', concurrency, 1, 500, 1, setConcurrency)}
        <div className="space-y-1">
          <div className="text-xs text-slate-400">Precision</div>
          <div className="flex gap-1">
            {KV_QUANT_OPTIONS.map((opt, i) => (
              <button
                key={opt.label}
                onClick={() => setQuantIdx(i)}
                className={`flex-1 text-[11px] px-2 py-1.5 rounded-lg border transition-colors ${
                  quantIdx === i
                    ? 'bg-cyan-500/20 border-cyan-500 text-cyan-200'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-800">
        <div className="bg-slate-950 rounded-xl p-3">
          <div className="text-[11px] text-slate-500">Per sequence</div>
          <div className="text-lg font-bold text-white font-mono">{formatBytes(perSequenceBytes)}</div>
        </div>
        <div className="bg-slate-950 rounded-xl p-3">
          <div className="text-[11px] text-slate-500">Total (× concurrency)</div>
          <div className="text-lg font-bold text-amber-300 font-mono">{formatBytes(totalBytes)}</div>
        </div>
      </div>
      <div className="text-[11px] text-slate-600 font-mono">
        layers({layers}) × 2 × heads({heads}) × head_dim({headDim}) × bytes({bytesPerParam}) × seq_len({seqLength.toLocaleString()})
      </div>
    </div>
  );
};

// --- Teaching panel: resolution cache, live ---
// Unlike the KV simulator above, this one is 100% real - it renders
// resolution_cache.py's actual counters from GET /cache/stats.
const CacheMemoryPanel: React.FC<{ stats: CacheStats | null }> = ({ stats }) => {
  if (!stats) {
    return (
      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
        <h3 className="text-sm font-bold text-white flex items-center space-x-2">
          <BookOpen className="w-4 h-4 text-emerald-400" />
          <span>Cache Memory — Live</span>
        </h3>
        <p className="text-xs text-slate-500">Waiting for first sync from the backend...</p>
      </div>
    );
  }

  return (
    <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-bold text-white flex items-center space-x-2">
          <BookOpen className="w-4 h-4 text-emerald-400" />
          <span>Cache Memory — Live</span>
        </h3>
        <span
          className={`text-[10px] uppercase tracking-wide rounded-full px-2 py-0.5 border ${
            stats.enabled
              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
              : 'bg-slate-700/30 text-slate-400 border-slate-600'
          }`}
        >
          {stats.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      <p className="text-xs text-slate-500 leading-relaxed">
        Real counters from resolution_cache.py, keyed on RAG citation id. A hit only ever skips the Resolver's flagship-model
        draft — the Critic still reviews every ticket regardless.
      </p>

      <div className="grid grid-cols-3 gap-3">
        <div className="bg-slate-950 rounded-xl p-3 text-center">
          <div className="text-xl font-bold text-emerald-300 font-mono">{stats.hit_rate_pct}%</div>
          <div className="text-[11px] text-slate-500">Hit rate</div>
        </div>
        <div className="bg-slate-950 rounded-xl p-3 text-center">
          <div className="text-xl font-bold text-white font-mono">{stats.hits}</div>
          <div className="text-[11px] text-slate-500">Hits</div>
        </div>
        <div className="bg-slate-950 rounded-xl p-3 text-center">
          <div className="text-xl font-bold text-white font-mono">{stats.misses}</div>
          <div className="text-[11px] text-slate-500">Misses</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 text-[11px] text-slate-500">
        <div>Entries: <span className="text-slate-300 font-mono">{stats.entries}/{stats.max_entries}</span></div>
        <div>TTL: <span className="text-slate-300 font-mono">{Math.round(stats.ttl_seconds / 3600)}h</span></div>
        <div>Min RAG conf: <span className="text-slate-300 font-mono">{stats.min_rag_confidence}</span></div>
      </div>

      {stats.question_cache && (
        <div className="bg-slate-950 rounded-xl p-3 text-[11px] text-slate-500">
          <span className="text-slate-300 font-semibold">Question cache</span> (skips Intake + Triage on exact repeats):{' '}
          <span className="text-emerald-300 font-mono">{stats.question_cache.hits} hits</span>
          {' / '}
          <span className="text-slate-300 font-mono">{stats.question_cache.misses} misses</span>
          {' · '}
          <span className="text-slate-300 font-mono">{stats.question_cache.hit_rate_pct}%</span>
          {' · '}
          <span className="text-slate-300 font-mono">{stats.question_cache.entries} entries</span>
        </div>
      )}

      {stats.recent_events.length > 0 && (
        <div className="pt-2 border-t border-slate-800 space-y-1.5 max-h-40 overflow-y-auto">
          {stats.recent_events.slice(0, 8).map((ev, i) => (
            <div key={i} className="flex items-center justify-between text-[11px]">
              <span
                className={
                  ev.event === 'hit'
                    ? 'text-emerald-400'
                    : ev.event === 'expired'
                    ? 'text-amber-400'
                    : 'text-slate-500'
                }
              >
                {ev.event} {ev.citation_id ? `· ${ev.citation_id}` : ''}
              </span>
              <span className="text-slate-600">{formatRelative(new Date(ev.at * 1000).toISOString())}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  tickets,
  onUpdateTicket,
  activityLogs,
  onAddActivityLog,
  onTriggerEmailToast,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<'tickets' | 'approvals' | 'activity' | 'analytics'>('tickets');
  
  // Table Filters State
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [priorityFilter, setPriorityFilter] = useState<string>('All');
  const [channelFilter, setChannelFilter] = useState<string>('All');
  const [dateFrom, setDateFrom] = useState<string>(''); // yyyy-mm-dd
  const [dateTo, setDateTo] = useState<string>(''); // yyyy-mm-dd

  // Selected Ticket for Detail Drawer
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);

  // Editing Draft State
  const [isEditingDraft, setIsEditingDraft] = useState(false);
  const [editedDraftText, setEditedDraftText] = useState('');

  // Live Activity Feed Simulation Toggle
  const [isFeedLive, setIsFeedLive] = useState(true);

  // Real backend usage stats - pulled from Cosmos DB via GET /tickets/stats,
  // covering every ticket from every user/session, not just the tickets
  // created locally in this browser tab (which is all `tickets` prop reflects).
  const { instance, accounts } = useMsal();
  const [backendStats, setBackendStats] = useState<BackendStats | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [backendTickets, setBackendTickets] = useState<Ticket[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(true);

  const REFRESH_INTERVAL_MS = 15000;

  const getAccessToken = async (): Promise<string | null> => {
    const account = accounts[0];
    if (!account) return null;
    try {
      const result = await instance.acquireTokenSilent({ ...tokenRequest, account });
      return result.accessToken;
    } catch (err) {
      // See matching comment in LiveChatInterface.tsx's getAccessToken -
      // falls back to popup for any silent failure, not just
      // InteractionRequiredAuthError, since Brave/Safari-style third-party
      // cookie blocking surfaces as BrowserAuthError: timed_out instead.
      console.warn('acquireTokenSilent failed, redirecting to sign in:', err);
      await instance.acquireTokenRedirect(tokenRequest);
      throw err;
    }
  };

  const syncLiveData = async () => {
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) return;
      const headers = { Authorization: `Bearer ${accessToken}` };

      const [statsRes, ticketsRes, cacheRes] = await Promise.all([
        fetch(`${BACKEND_URL}/tickets/stats`, { headers }),
        fetch(`${BACKEND_URL}/tickets?limit=200`, { headers }),
        fetch(`${BACKEND_URL}/cache/stats`, { headers }),
      ]);
      if (!statsRes.ok) throw new Error(`Stats endpoint returned ${statsRes.status}`);
      if (!ticketsRes.ok) throw new Error(`Tickets endpoint returned ${ticketsRes.status}`);
      // Cache stats are a bonus panel, not core dashboard function - don't
      // fail the whole sync if this one endpoint has a problem.
      if (cacheRes.ok) setCacheStats(await cacheRes.json());

      const statsData: BackendStats = await statsRes.json();
      const ticketDocs: any[] = await ticketsRes.json();

      setBackendStats(statsData);
      setBackendTickets(ticketDocs.map(mapBackendTicket));
      setStatsError(null);
      setLastSyncedAt(new Date());
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Failed to load live backend data');
    } finally {
      setStatsLoading(false);
    }
  };

  // Calls the real human-in-the-loop endpoint for a backend-sourced ticket,
  // then re-syncs so the queue reflects the actual persisted decision rather
  // than an optimistic local edit that the next poll would otherwise revert.
  const postHumanDecision = async (backendTicketId: string, decision: 'approved' | 'rejected', notes = '') => {
    const accessToken = await getAccessToken();
    if (!accessToken) return;
    const res = await fetch(`${BACKEND_URL}/tickets/${backendTicketId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ decision, notes }),
    });
    if (!res.ok) throw new Error(`Decision endpoint returned ${res.status}`);
    await syncLiveData();
  };

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const tick = async () => {
      if (cancelled) return;
      await syncLiveData();
    };

    tick();
    if (liveEnabled) {
      intervalId = setInterval(tick, REFRESH_INTERVAL_MS);
    }
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, accounts, liveEnabled]);

  // Prefer real backend tickets (every user, every session) once they've
  // loaded; fall back to the local/mock tickets prop so the demo still
  // renders something if the API is unreachable.
  const effectiveTickets = backendTickets.length > 0 ? backendTickets : tickets;

  // Calculate High-level Summary Metrics
  const totalTicketsCount = effectiveTickets.length;
  const openTicketsCount = effectiveTickets.filter(t => t.status === 'Open' || t.status === 'In Progress').length;
  const pendingApprovalsCount = effectiveTickets.filter(t => t.status === 'Pending Approval').length;
  const resolvedCount = effectiveTickets.filter(t => t.status === 'Resolved').length;
  const autoResolvedCount = effectiveTickets.filter(t => t.status === 'Resolved' && t.assignedAgent.includes('AI')).length;
  const autoResolveRate = totalTicketsCount > 0 ? Math.round((autoResolvedCount / totalTicketsCount) * 100) : 82;
  const escalatedCount = effectiveTickets.filter(t => t.status === 'Escalated').length;

  // Filtered Tickets Table
  const filteredTickets = useMemo(() => {
    // Date bounds are inclusive; dateTo is bumped to end-of-day so a ticket
    // created any time on that day still matches.
    const fromMs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toMs = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : null;

    return effectiveTickets.filter((t) => {
      const matchesSearch =
        t.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.customer.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.category.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesStatus = statusFilter === 'All' || t.status === statusFilter;
      const matchesPriority = priorityFilter === 'All' || t.priority === priorityFilter;
      const matchesChannel = channelFilter === 'All' || t.channel === channelFilter;

      let matchesDate = true;
      if (fromMs !== null || toMs !== null) {
        const createdMs = t.createdAtIso ? new Date(t.createdAtIso).getTime() : NaN;
        if (Number.isNaN(createdMs)) {
          matchesDate = false; // unknown-date (mock) tickets drop out once a date filter is applied
        } else {
          matchesDate = (fromMs === null || createdMs >= fromMs) && (toMs === null || createdMs <= toMs);
        }
      }

      return matchesSearch && matchesStatus && matchesPriority && matchesChannel && matchesDate;
    });
  }, [effectiveTickets, searchQuery, statusFilter, priorityFilter, channelFilter, dateFrom, dateTo]);

  // Analytics Chart Data
  const categoryData = useMemo(() => {
    const counts: Record<string, number> = {};
    effectiveTickets.forEach((t) => {
      counts[t.category] = (counts[t.category] || 0) + 1;
    });
    return Object.keys(counts).map((cat) => ({
      category: cat.split(' ')[0], // short name
      tickets: counts[cat],
    }));
  }, [effectiveTickets]);

  const channelData = useMemo(() => {
    const counts: Record<string, number> = {};
    effectiveTickets.forEach((t) => {
      counts[t.channel] = (counts[t.channel] || 0) + 1;
    });
    return [
      { name: 'Chat', value: counts['chat'] || 4, color: '#06b6d4' },
      { name: 'Email', value: counts['email'] || 3, color: '#6366f1' },
      { name: 'Call', value: counts['call'] || 2, color: '#10b981' },
      { name: 'Slack', value: counts['slack'] || 2, color: '#a855f7' },
      { name: 'Portal', value: counts['portal'] || 3, color: '#f59e0b' },
    ];
  }, [effectiveTickets]);

  const trendData = [
    { day: 'Mon', total: 24, autoResolved: 18 },
    { day: 'Tue', total: 32, autoResolved: 26 },
    { day: 'Wed', total: 28, autoResolved: 22 },
    { day: 'Thu', total: 40, autoResolved: 34 },
    { day: 'Fri', total: 35, autoResolved: 30 },
    { day: 'Sat', total: 18, autoResolved: 15 },
    { day: 'Sun', total: 22, autoResolved: 19 },
  ];

  // Action Handlers
  const handleApproveDraft = async (tck: Ticket) => {
    const updated: Ticket = {
      ...tck,
      status: 'Resolved',
      assignedAgent: 'AI Agent (Human Approved)',
      lastUpdated: 'Just now',
    };
    onUpdateTicket(updated);
    if (selectedTicket?.id === tck.id) setSelectedTicket(updated);

    onAddActivityLog({
      id: `act-${Date.now()}`,
      timestamp: 'Just now',
      type: 'auto_resolved',
      message: `Admin approved draft response for Ticket #${tck.id} (${tck.customer.name}).`,
      ticketId: tck.id,
      channel: tck.channel,
    });

    onTriggerEmailToast(
      tck.customer.email,
      `Your support ticket #${tck.id} has been resolved`,
      tck.id,
      'Resolved'
    );

    // If this is a real backend-sourced ticket, persist the decision so it
    // actually closes out in Cosmos DB - otherwise the next live poll would
    // silently revert this row back to "Pending Approval".
    if (tck.backendTicketId) {
      try {
        await postHumanDecision(tck.backendTicketId, 'approved');
      } catch (err) {
        setStatsError(err instanceof Error ? err.message : 'Failed to record approval on backend');
      }
    }
  };

  const handleEscalateToHuman = async (tck: Ticket) => {
    const updated: Ticket = {
      ...tck,
      status: 'Escalated',
      assignedAgent: 'Senior Support Agent: Dave Rogers',
      lastUpdated: 'Just now',
    };
    onUpdateTicket(updated);
    if (selectedTicket?.id === tck.id) setSelectedTicket(updated);

    onAddActivityLog({
      id: `act-${Date.now()}`,
      timestamp: 'Just now',
      type: 'escalated',
      message: `Ticket #${tck.id} escalated to Senior Agent Dave Rogers.`,
      ticketId: tck.id,
      channel: tck.channel,
    });

    onTriggerEmailToast(
      tck.customer.email,
      `Update regarding your ticket #${tck.id}: Escalated to Tier 2 Support`,
      tck.id,
      'Escalated'
    );

    if (tck.backendTicketId) {
      try {
        await postHumanDecision(tck.backendTicketId, 'rejected');
      } catch (err) {
        setStatsError(err instanceof Error ? err.message : 'Failed to record rejection on backend');
      }
    }
  };

  const handleSimulateRandomEvent = () => {
    const randomChannels: TicketChannel[] = ['chat', 'email', 'call', 'slack', 'portal'];
    const randChannel = randomChannels[Math.floor(Math.random() * randomChannels.length)];
    const randId = `TCK-${Math.floor(4600 + Math.random() * 200)}`;

    const eventTypes: ('new_ticket' | 'auto_resolved' | 'escalated')[] = ['new_ticket', 'auto_resolved', 'escalated'];
    const chosenType = eventTypes[Math.floor(Math.random() * eventTypes.length)];

    let msg = '';
    if (chosenType === 'new_ticket') msg = `New ticket #${randId} received via ${randChannel.toUpperCase()} (Camera detection query).`;
    else if (chosenType === 'auto_resolved') msg = `AI Agent auto-resolved Ticket #${randId} with 95% confidence.`;
    else msg = `High severity alert triggered — Ticket #${randId} escalated to Tier 2.`;

    onAddActivityLog({
      id: `act-${Date.now()}`,
      timestamp: 'Just now',
      type: chosenType,
      message: msg,
      ticketId: randId,
      channel: randChannel,
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-6 lg:p-8 space-y-8">
      
      {/* Page Title & Navigation Tabs */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
              <LayoutDashboard className="w-4 h-4" />
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Enterprise Support Control Desk</h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">Real-time ticket orchestration, AI confidence monitoring, & SLA compliance</p>
        </div>

        {/* Admin Sub-Tabs */}
        <div className="flex items-center space-x-1 bg-slate-900 p-1.5 rounded-xl border border-slate-800 overflow-x-auto">
          <button
            id="tab-all-tickets"
            onClick={() => setActiveSubTab('tickets')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition ${
              activeSubTab === 'tickets'
                ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            <span>All Tickets ({effectiveTickets.length})</span>
          </button>

          <button
            id="tab-approvals-queue"
            onClick={() => setActiveSubTab('approvals')}
            className={`relative px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition ${
              activeSubTab === 'approvals'
                ? 'bg-amber-600 text-white shadow-md shadow-amber-600/30'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
            <span>Pending Approvals Queue</span>
            {pendingApprovalsCount > 0 && (
              <span className="bg-amber-500 text-slate-950 px-1.5 py-0.2 rounded-full font-bold text-[10px]">
                {pendingApprovalsCount}
              </span>
            )}
          </button>

          <button
            id="tab-activity-feed"
            onClick={() => setActiveSubTab('activity')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition ${
              activeSubTab === 'activity'
                ? 'bg-cyan-600 text-white shadow-md shadow-cyan-600/30'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
            <span>Live Activity Feed</span>
          </button>

          <button
            id="tab-analytics"
            onClick={() => setActiveSubTab('analytics')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition ${
              activeSubTab === 'analytics'
                ? 'bg-purple-600 text-white shadow-md shadow-purple-600/30'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            <PieChartIcon className="w-3.5 h-3.5 text-purple-400" />
            <span>Analytics & Insights</span>
          </button>
        </div>
      </div>

      {/* LIVE BACKEND USAGE - real Cosmos DB data across every user/session, not just this browser tab */}
      <div className="bg-slate-900 border border-cyan-500/30 rounded-2xl shadow-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-cyan-400 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" /> Live Backend Usage (Cosmos DB — all users)
          </p>
          <div className="flex items-center gap-3">
            {statsLoading && <span className="text-[10px] text-slate-500">Loading…</span>}
            {statsError && <span className="text-[10px] text-red-400">{statsError}</span>}
            {!statsLoading && !statsError && (
              <span className="text-[10px] text-slate-500 flex items-center gap-1.5">
                {liveEnabled && (
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                )}
                {lastSyncedAt ? `Synced ${formatRelative(lastSyncedAt.toISOString())}` : ''}
              </span>
            )}
            <button
              onClick={() => setLiveEnabled((v) => !v)}
              className="text-[10px] font-semibold px-2 py-0.5 rounded-md border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500"
            >
              {liveEnabled ? 'Pause live' : 'Resume live'}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">Users Came</p>
            <span className="text-2xl font-black text-white">{backendStats?.unique_users ?? '—'}</span>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">Total Tickets</p>
            <span className="text-2xl font-black text-white">{backendStats?.total_tickets ?? '—'}</span>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wider text-emerald-400">Resolved</p>
            <span className="text-2xl font-black text-emerald-400">{backendStats?.resolved ?? '—'}</span>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wider text-red-400">Escalated</p>
            <span className="text-2xl font-black text-red-400">{backendStats?.escalated ?? '—'}</span>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wider text-amber-400">Not Resolved Yet</p>
            <span className="text-2xl font-black text-amber-400">{backendStats?.not_resolved ?? '—'}</span>
          </div>
        </div>
        {backendStats && (
          <p className="text-[10px] text-slate-500 mt-2">
            {backendStats.resolution_rate_pct}% resolution rate across {Object.keys(backendStats.by_channel).length} channel(s)
          </p>
        )}
      </div>

      {/* TOP SUMMARY KPI CARDS */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">

        {/* Total Tickets */}
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-lg space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Total Tickets</p>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-white">{totalTicketsCount}</span>
            <span className="text-[10px] text-emerald-400 font-mono flex items-center">
              +14% <ArrowUpRight className="w-3 h-3 ml-0.5" />
            </span>
          </div>
          <p className="text-[10px] text-slate-500">Across 5 channels</p>
        </div>

        {/* Open Tickets */}
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-lg space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Open & Active</p>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-cyan-400">{openTicketsCount}</span>
            <span className="text-[10px] text-cyan-400 font-mono">In Progress</span>
          </div>
          <p className="text-[10px] text-slate-500">SLA level satisfied</p>
        </div>

        {/* Auto-Resolved Rate */}
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-lg space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">AI Auto-Resolve Rate</p>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-emerald-400">{autoResolveRate}%</span>
            <span className="text-[10px] text-emerald-400 font-mono">{autoResolvedCount} tickets</span>
          </div>
          <p className="text-[10px] text-slate-500">Zero human intervention</p>
        </div>

        {/* Pending Human Approval */}
        <div className="bg-slate-900 border border-amber-500/30 p-4 rounded-2xl shadow-lg space-y-1 bg-amber-500/5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">Needs Approval</p>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-amber-400">{pendingApprovalsCount}</span>
            <span className="text-[10px] text-amber-400 font-mono">Low AI Confidence</span>
          </div>
          <p className="text-[10px] text-slate-400">Awaiting Human Review</p>
        </div>

        {/* Avg Resolution Time */}
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-lg space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Avg Resolution Time</p>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-indigo-400">1.8m</span>
            <span className="text-[10px] text-emerald-400 font-mono">-45s vs benchmark</span>
          </div>
          <p className="text-[10px] text-slate-500">Target: &lt; 5 mins</p>
        </div>

        {/* CSAT Score */}
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-lg space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">CSAT Score</p>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-purple-400 flex items-center space-x-1">
              <span>4.9</span>
              <Star className="w-4 h-4 fill-purple-400 text-purple-400" />
            </span>
            <span className="text-[10px] text-purple-400 font-mono">98% Satisfied</span>
          </div>
          <p className="text-[10px] text-slate-500">From 1,240 reviews</p>
        </div>

      </div>

      {/* SUB-VIEW 1: ALL TICKETS TABLE */}
      {activeSubTab === 'tickets' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl space-y-4 p-6">
          
          {/* Filters Bar */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            
            {/* Search Input */}
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              <input
                id="admin-ticket-search-input"
                type="text"
                placeholder="Search ticket ID, customer name, topic..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs sm:text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              />
            </div>

            {/* Select Dropdowns */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              
              {/* Status Filter */}
              <div className="flex items-center space-x-1 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800">
                <span className="text-slate-400 font-medium">Status:</span>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="bg-transparent text-white focus:outline-none cursor-pointer"
                >
                  <option value="All" className="bg-slate-900">All</option>
                  <option value="Open" className="bg-slate-900">Open</option>
                  <option value="In Progress" className="bg-slate-900">In Progress</option>
                  <option value="Pending Approval" className="bg-slate-900">Pending Approval</option>
                  <option value="Resolved" className="bg-slate-900">Resolved</option>
                  <option value="Escalated" className="bg-slate-900">Escalated</option>
                </select>
              </div>

              {/* Priority Filter */}
              <div className="flex items-center space-x-1 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800">
                <span className="text-slate-400 font-medium">Priority:</span>
                <select
                  value={priorityFilter}
                  onChange={(e) => setPriorityFilter(e.target.value)}
                  className="bg-transparent text-white focus:outline-none cursor-pointer"
                >
                  <option value="All" className="bg-slate-900">All</option>
                  <option value="Urgent" className="bg-slate-900">Urgent</option>
                  <option value="High" className="bg-slate-900">High</option>
                  <option value="Medium" className="bg-slate-900">Medium</option>
                  <option value="Low" className="bg-slate-900">Low</option>
                </select>
              </div>

              {/* Channel Filter */}
              <div className="flex items-center space-x-1 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800">
                <span className="text-slate-400 font-medium">Channel:</span>
                <select
                  value={channelFilter}
                  onChange={(e) => setChannelFilter(e.target.value)}
                  className="bg-transparent text-white focus:outline-none cursor-pointer"
                >
                  <option value="All" className="bg-slate-900">All</option>
                  <option value="chat" className="bg-slate-900">Chat</option>
                  <option value="email" className="bg-slate-900">Email</option>
                  <option value="call" className="bg-slate-900">Call</option>
                  <option value="slack" className="bg-slate-900">Slack</option>
                  <option value="portal" className="bg-slate-900">Portal</option>
                </select>
              </div>

              {/* Date Range Filter */}
              <div className="flex items-center space-x-1.5 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800">
                <span className="text-slate-400 font-medium">From:</span>
                <input
                  id="admin-date-from"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="bg-transparent text-white focus:outline-none cursor-pointer [color-scheme:dark]"
                />
                <span className="text-slate-400 font-medium">To:</span>
                <input
                  id="admin-date-to"
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="bg-transparent text-white focus:outline-none cursor-pointer [color-scheme:dark]"
                />
                {(dateFrom || dateTo) && (
                  <button
                    onClick={() => { setDateFrom(''); setDateTo(''); }}
                    className="text-slate-500 hover:text-white ml-1"
                    title="Clear date filter"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

            </div>

          </div>

          {/* Table */}
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left border-collapse text-xs sm:text-sm">
              <thead>
                <tr className="bg-slate-950/80 text-slate-400 font-semibold uppercase tracking-wider text-[11px] border-b border-slate-800">
                  <th className="p-3.5">Ticket ID</th>
                  <th className="p-3.5">Customer</th>
                  <th className="p-3.5">Channel</th>
                  <th className="p-3.5">Category & Subject</th>
                  <th className="p-3.5">Priority</th>
                  <th className="p-3.5">Status</th>
                  <th className="p-3.5">Assigned Agent</th>
                  <th className="p-3.5">Created</th>
                  <th className="p-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-slate-200">
                {filteredTickets.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-center py-8 text-slate-500">
                      No tickets match the selected filter criteria.
                    </td>
                  </tr>
                ) : (
                  filteredTickets.map((tck) => (
                    <tr
                      key={tck.id}
                      onClick={() => setSelectedTicket(tck)}
                      className="hover:bg-slate-800/50 cursor-pointer transition"
                    >
                      <td className="p-3.5 font-mono text-cyan-400 font-bold">{tck.id}</td>
                      <td className="p-3.5">
                        <div className="flex items-center space-x-2">
                          <img
                            src={tck.customer.avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80'}
                            alt=""
                            className="w-6 h-6 rounded-full object-cover"
                          />
                          <div>
                            <p className="font-semibold text-white line-clamp-1">{tck.customer.name}</p>
                            <span className="text-[10px] text-slate-400 font-mono">{tck.customer.tier} Tier</span>
                          </div>
                        </div>
                      </td>
                      <td className="p-3.5 capitalize font-medium">
                        <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 text-[11px]">
                          {tck.channel === 'chat' && <MessageSquare className="w-3 h-3 text-cyan-400" />}
                          {tck.channel === 'email' && <Mail className="w-3 h-3 text-indigo-400" />}
                          {tck.channel === 'call' && <Phone className="w-3 h-3 text-emerald-400" />}
                          {tck.channel === 'slack' && <Slack className="w-3 h-3 text-purple-400" />}
                          {tck.channel === 'portal' && <Send className="w-3 h-3 text-amber-400" />}
                          <span>{tck.channel}</span>
                        </span>
                      </td>
                      <td className="p-3.5 max-w-xs">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400 block">
                          {tck.category}
                        </span>
                        <p className="font-medium text-slate-100 line-clamp-1 mt-0.5">{tck.subject}</p>
                      </td>
                      <td className="p-3.5">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                            tck.priority === 'Urgent'
                              ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                              : tck.priority === 'High'
                              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                              : tck.priority === 'Medium'
                              ? 'bg-blue-500/20 text-cyan-300 border border-blue-500/40'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {tck.priority}
                        </span>
                      </td>
                      <td className="p-3.5">
                        <span
                          className={`px-2.5 py-1 rounded-full text-[11px] font-semibold flex items-center space-x-1 w-fit ${
                            tck.status === 'Resolved'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                              : tck.status === 'Pending Approval'
                              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                              : tck.status === 'Escalated'
                              ? 'bg-red-500/10 text-red-400 border border-red-500/30'
                              : 'bg-blue-500/10 text-cyan-400 border border-blue-500/30'
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              tck.status === 'Resolved'
                                ? 'bg-emerald-400'
                                : tck.status === 'Pending Approval'
                                ? 'bg-amber-400 animate-pulse'
                                : tck.status === 'Escalated'
                                ? 'bg-red-400'
                                : 'bg-cyan-400'
                            }`}
                          ></span>
                          <span>{tck.status}</span>
                        </span>
                      </td>
                      <td className="p-3.5 text-xs">
                        <span className="font-medium text-slate-300 flex items-center space-x-1">
                          {tck.assignedAgent.includes('AI') ? (
                            <Bot className="w-3.5 h-3.5 text-cyan-400" />
                          ) : (
                            <UserCheck className="w-3.5 h-3.5 text-emerald-400" />
                          )}
                          <span className="line-clamp-1">{tck.assignedAgent}</span>
                        </span>
                      </td>
                      <td className="p-3.5 text-slate-400 font-mono text-xs">{tck.createdTime}</td>
                      <td className="p-3.5 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedTicket(tck);
                          }}
                          className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-400 text-xs font-medium border border-slate-700"
                        >
                          Inspect
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

        </div>
      )}

      {/* SUB-VIEW 2: PENDING APPROVALS QUEUE */}
      {activeSubTab === 'approvals' && (
        <div className="space-y-4">
          <div className="bg-amber-500/10 border border-amber-500/30 p-4 rounded-2xl text-amber-200 text-xs flex items-center space-x-3">
            <ShieldAlert className="w-6 h-6 text-amber-400 flex-shrink-0" />
            <div>
              <h3 className="font-bold text-sm text-amber-300">Human Safeguard Queue</h3>
              <p className="text-amber-200/80 mt-0.5">
                The AI Agent detected confidence score &lt; 75% or enterprise credit action constraints. Review AI drafted response below before approving dispatch.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {effectiveTickets.filter(t => t.status === 'Pending Approval').length === 0 ? (
              <div className="col-span-2 text-center py-12 bg-slate-900 rounded-2xl border border-slate-800">
                <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
                <p className="text-white font-bold">All Low-Confidence Flags Approved!</p>
                <p className="text-slate-400 text-xs mt-1">There are currently no pending human approval tasks in queue.</p>
              </div>
            ) : (
              effectiveTickets.filter(t => t.status === 'Pending Approval').map((tck) => (
                <div
                  key={tck.id}
                  className="bg-slate-900 border border-amber-500/30 rounded-2xl p-6 shadow-xl space-y-4 flex flex-col justify-between"
                >
                  <div className="space-y-3">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                      <div className="flex items-center space-x-2">
                        <span className="font-mono text-cyan-400 font-bold text-sm">#{tck.id}</span>
                        <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 rounded text-[10px] font-bold border border-amber-500/30">
                          Confidence: {tck.confidenceScore}%
                        </span>
                      </div>
                      <span className="text-xs text-slate-400 font-mono">{tck.createdTime}</span>
                    </div>

                    <div>
                      <span className="text-[10px] font-bold uppercase text-cyan-400">{tck.category}</span>
                      <h4 className="font-bold text-base text-white">{tck.subject}</h4>
                      <p className="text-xs text-slate-300 mt-1 bg-slate-950 p-3 rounded-xl border border-slate-800">
                        "{tck.description}"
                      </p>
                    </div>

                    {/* Customer info */}
                    <div className="flex items-center space-x-3 text-xs bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
                      <img src={tck.customer.avatar} alt="" className="w-7 h-7 rounded-full object-cover" />
                      <div>
                        <span className="font-semibold text-white">{tck.customer.name}</span>
                        <p className="text-[10px] text-slate-400">{tck.customer.company} ({tck.customer.tier} Tier)</p>
                      </div>
                    </div>

                    {/* AI Draft Response */}
                    <div className="space-y-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400 flex items-center space-x-1">
                        <Bot className="w-3.5 h-3.5" />
                        <span>AI Drafted Response (Awaiting Approval):</span>
                      </span>

                      {isEditingDraft && selectedTicket?.id === tck.id ? (
                        <textarea
                          rows={4}
                          value={editedDraftText}
                          onChange={(e) => setEditedDraftText(e.target.value)}
                          className="w-full p-3 bg-slate-950 border border-amber-500/50 rounded-xl text-xs text-white"
                        />
                      ) : (
                        <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl text-xs text-slate-200 leading-relaxed font-mono">
                          {tck.aiDraftResponse || 'Standard draft response generated.'}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="pt-4 border-t border-slate-800 flex items-center justify-between gap-2">
                    <button
                      onClick={() => handleEscalateToHuman(tck)}
                      className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-red-400 text-xs font-semibold rounded-xl border border-slate-700 transition"
                    >
                      Reject & Escalate
                    </button>

                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => {
                          setSelectedTicket(tck);
                          setEditedDraftText(tck.aiDraftResponse || '');
                          setIsEditingDraft(!isEditingDraft);
                        }}
                        className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl border border-slate-700 transition flex items-center space-x-1"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                        <span>{isEditingDraft ? 'Cancel Edit' : 'Edit Draft'}</span>
                      </button>

                      <button
                        onClick={() => handleApproveDraft(tck)}
                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-emerald-500/20 transition flex items-center space-x-1.5"
                      >
                        <Check className="w-4 h-4" />
                        <span>Approve & Send Email</span>
                      </button>
                    </div>
                  </div>

                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* SUB-VIEW 3: LIVE ACTIVITY FEED */}
      {activeSubTab === 'activity' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <h3 className="text-lg font-bold text-white flex items-center space-x-2">
                <Activity className="w-5 h-5 text-cyan-400" />
                <span>Real-Time Support Event Stream</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">Live monitoring of system-wide AI actions, escalations, & incoming tickets</p>
            </div>

            <div className="flex items-center space-x-3">
              <button
                onClick={() => setIsFeedLive(!isFeedLive)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center space-x-1.5 border transition ${
                  isFeedLive
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-slate-800 text-slate-400 border-slate-700'
                }`}
              >
                {isFeedLive ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                <span>{isFeedLive ? 'Feed Live' : 'Feed Paused'}</span>
              </button>

              <button
                id="btn-simulate-event"
                onClick={handleSimulateRandomEvent}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-xl shadow-md transition flex items-center space-x-1.5"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Simulate Event</span>
              </button>
            </div>
          </div>

          <div className="space-y-3 max-h-[500px] overflow-y-auto pr-2">
            {activityLogs.map((log) => (
              <div
                key={log.id}
                className="p-4 bg-slate-950 rounded-xl border border-slate-800 flex items-start justify-between text-xs space-x-4 animate-in fade-in"
              >
                <div className="flex items-start space-x-3">
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-white mt-0.5 ${
                      log.type === 'auto_resolved'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : log.type === 'approval_required'
                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : log.type === 'escalated'
                        ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                        : 'bg-blue-500/20 text-cyan-400 border border-blue-500/30'
                    }`}
                  >
                    <Zap className="w-4 h-4" />
                  </div>

                  <div>
                    <div className="flex items-center space-x-2">
                      <span className="font-bold text-slate-100">{log.message}</span>
                    </div>
                    <div className="flex items-center space-x-2 text-[10px] text-slate-500 mt-1">
                      <span className="font-mono text-cyan-400">Ref: #{log.ticketId}</span>
                      <span>•</span>
                      <span className="capitalize">Channel: {log.channel}</span>
                    </div>
                  </div>
                </div>

                <span className="text-[10px] text-slate-400 font-mono flex-shrink-0">{log.timestamp}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SUB-VIEW 4: ANALYTICS & INSIGHTS CHARTS */}
      {activeSubTab === 'analytics' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          
          {/* Tickets by Category */}
          <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center space-x-2">
              <BarChart3 className="w-4 h-4 text-cyan-400" />
              <span>Tickets by Issue Category</span>
            </h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="category" stroke="#94a3b8" fontSize={11} />
                  <YAxis stroke="#94a3b8" fontSize={11} />
                  <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#fff' }} />
                  <Bar dataKey="tickets" fill="#06b6d4" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Tickets by Channel */}
          <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center space-x-2">
              <PieChartIcon className="w-4 h-4 text-purple-400" />
              <span>Channel Volume Share</span>
            </h3>
            <div className="h-64 flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={channelData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={4}
                    dataKey="value"
                  >
                    {channelData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#fff' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Resolution Trend over Time */}
          <div className="col-span-1 lg:col-span-2 bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center space-x-2">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <span>AI Auto-Resolution vs Total Volume Trend (7 Days)</span>
            </h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="day" stroke="#94a3b8" fontSize={11} />
                  <YAxis stroke="#94a3b8" fontSize={11} />
                  <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#fff' }} />
                  <Area type="monotone" dataKey="total" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.2} />
                  <Area type="monotone" dataKey="autoResolved" stroke="#10b981" fill="#10b981" fillOpacity={0.4} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Cache Memory (live) + KV Cache (simulated) - teaching panels */}
          <CacheMemoryPanel stats={cacheStats} />
          <KVCacheSimulator />

        </div>
      )}

      {/* RICH TICKET DETAIL DRAWER / MODAL */}
      {selectedTicket && (
        <div className="fixed inset-0 z-50 flex items-center justify-end bg-slate-950/80 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 w-full max-w-2xl h-full rounded-2xl border border-slate-800 shadow-2xl flex flex-col overflow-hidden text-slate-100">
            
            {/* Drawer Header */}
            <div className="p-5 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
              <div>
                <div className="flex items-center space-x-2">
                  <span className="font-mono text-cyan-400 font-bold text-base">#{selectedTicket.id}</span>
                  <span className="px-2 py-0.5 rounded bg-blue-500/20 text-cyan-300 text-xs font-semibold border border-blue-500/30">
                    {selectedTicket.status}
                  </span>
                </div>
                <h3 className="font-bold text-sm text-white line-clamp-1 mt-1">{selectedTicket.subject}</h3>
              </div>
              <button
                onClick={() => setSelectedTicket(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Drawer Body */}
            <div className="p-6 overflow-y-auto space-y-6 text-xs sm:text-sm">
              
              {/* Customer Banner */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <img
                    src={selectedTicket.customer.avatar}
                    alt=""
                    className="w-10 h-10 rounded-full object-cover border border-slate-700"
                  />
                  <div>
                    <h4 className="font-bold text-white text-sm">{selectedTicket.customer.name}</h4>
                    <p className="text-slate-400 text-xs">{selectedTicket.customer.email}</p>
                  </div>
                </div>
                <div className="text-right text-xs">
                  <span className="font-semibold text-emerald-400 block">{selectedTicket.customer.tier} Tier</span>
                  <span className="text-slate-500">{selectedTicket.customer.priorTicketsCount} prior tickets</span>
                </div>
              </div>

              {/* Category, Priority, Channel */}
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                  <span className="text-slate-500 block uppercase font-bold text-[10px]">Category</span>
                  <span className="text-white font-medium">{selectedTicket.category}</span>
                </div>
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                  <span className="text-slate-500 block uppercase font-bold text-[10px]">Priority</span>
                  <span className="text-amber-400 font-semibold">{selectedTicket.priority}</span>
                </div>
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                  <span className="text-slate-500 block uppercase font-bold text-[10px]">Channel</span>
                  <span className="text-cyan-400 font-medium capitalize">{selectedTicket.channel}</span>
                </div>
              </div>

              {/* RAG & Agent Trace Info */}
              {selectedTicket.confidenceScore !== undefined && (
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-cyan-400 flex items-center space-x-1">
                      <Bot className="w-4 h-4" />
                      <span>RAG Evaluation Score</span>
                    </span>
                    <span className="font-mono text-emerald-400 font-bold">{selectedTicket.confidenceScore}%</span>
                  </div>
                  {selectedTicket.kbUsed && (
                    <p className="text-xs text-slate-300">
                      KB Citation Used: <code className="text-cyan-300">{selectedTicket.kbUsed.join(', ')}</code>
                    </p>
                  )}
                  {selectedTicket.backendActionTaken && (
                    <p className="text-xs text-emerald-300 font-mono">
                      {selectedTicket.backendActionTaken}
                    </p>
                  )}
                </div>
              )}

              {/* Issue Description */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Original Request Description</h4>
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-slate-200 font-mono text-xs leading-relaxed">
                  {selectedTicket.description}
                </div>
              </div>

              {/* Conversation Log */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Conversation History</h4>
                <div className="space-y-3">
                  {selectedTicket.conversationHistory.map((m) => (
                    <div key={m.id} className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-xs space-y-1">
                      <div className="flex items-center justify-between text-[10px] text-slate-400">
                        <span className="font-bold text-white">{m.senderName}</span>
                        <span>{m.timestamp}</span>
                      </div>
                      <p className="text-slate-300">{m.text}</p>
                    </div>
                  ))}
                </div>
              </div>

            </div>

            {/* Drawer Footer Actions */}
            <div className="p-4 bg-slate-950 border-t border-slate-800 flex items-center justify-between">
              <button
                onClick={() => handleEscalateToHuman(selectedTicket)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-red-400 font-semibold text-xs rounded-xl border border-slate-700 transition"
              >
                Escalate to Human
              </button>

              <button
                onClick={() => handleApproveDraft(selectedTicket)}
                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl shadow-lg transition"
              >
                Mark Resolved & Send Email
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
};
