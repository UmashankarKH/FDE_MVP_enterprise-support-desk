import React, { useState } from 'react';
import { Send, Bot, User, Sparkles, CheckCircle2, ShieldAlert, AlertTriangle, FileText, ArrowRight, ExternalLink } from 'lucide-react';
import { useMsal } from '@azure/msal-react';
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { ChatMessage, Ticket, MultiAgentStep, LoopMetadata } from '../../types';
import { tokenRequest } from '../../authConfig';

interface LiveChatInterfaceProps {
  initialQuery?: string;
  onTicketCreatedOrUpdated: (ticket: Ticket) => void;
  userTickets: Ticket[];
}

const BACKEND_URL = import.meta.env.VITE_API_BASE_URL || 'https://fde-backend-api.niceforest-3c4b30ba.eastus.azurecontainerapps.io';

export const LiveChatInterface: React.FC<LiveChatInterfaceProps> = ({
  initialQuery = '',
  onTicketCreatedOrUpdated,
}) => {
  const { instance, accounts } = useMsal();
  const [inputMessage, setInputMessage] = useState(initialQuery);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'msg-welcome',
      sender: 'ai',
      senderName: 'AI Agent Desk',
      text: 'Welcome to Umashankar Support Agent Portal. How can we help you today?',
      timestamp: 'Just now',
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeSteps, setActiveSteps] = useState<MultiAgentStep[]>([]);
  const [confidenceScore, setConfidenceScore] = useState<number | null>(null);
  const [loopMetadata, setLoopMetadata] = useState<LoopMetadata | null>(null);

  // Acquire an access token for the backend API scope. Tries the silent
  // (cached/refresh) path first since that's instant and doesn't interrupt
  // the user; only falls back to an interactive popup if the silent grant
  // truly requires it (e.g. token expired past refresh, consent revoked).
  const getAccessToken = async (): Promise<string> => {
    const account = accounts[0];
    try {
      const result = await instance.acquireTokenSilent({ ...tokenRequest, account });
      return result.accessToken;
    } catch (err) {
      // Falls back to an interactive popup for ANY silent-acquisition
      // failure, not just InteractionRequiredAuthError. MSAL's silent path
      // uses a hidden iframe for SSO renewal when there's no cached token
      // for this scope yet, and that iframe depends on third-party cookies
      // to login.microsoftonline.com - browsers with strict tracker/cookie
      // blocking (Brave Shields, Safari ITP, Chrome third-party cookie
      // phase-out) block it outright, which surfaces as
      // BrowserAuthError: timed_out rather than InteractionRequiredAuthError.
      // A real popup is a user-gesture window, not a background iframe, so
      // it isn't subject to the same blocking.
      // Uses a full-page REDIRECT, not a popup. By the time silent renewal
      // times out (~10s), the click's user-gesture is long gone, so browsers
      // block any popup opened from here - clicking Send again never fixes
      // it. A redirect needs no gesture, works in Brave, and returns the
      // user to this page with a fresh token.
      console.warn('acquireTokenSilent failed, redirecting to sign in:', err);
      await instance.acquireTokenRedirect(tokenRequest);
      throw err;
    }
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputMessage.trim() || isProcessing) return;

    const userText = inputMessage.trim();
    setInputMessage('');

    // Add user message
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      sender: 'user',
      senderName: 'Alex Mercer',
      text: userText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsProcessing(true);
    setConfidenceScore(null);

    // Initial reasoning steps
    const initialSteps: MultiAgentStep[] = [
      { agentName: 'Intake Agent', status: 'in_progress', message: 'Analyzing incoming ticket text...', timestamp: 'Just now' },
      { agentName: 'Triage Agent', status: 'pending', message: 'Categorizing query domain...', timestamp: 'Just now' },
      { agentName: 'RAG Agent', status: 'pending', message: 'Searching Azure AI Search Knowledge Base...', timestamp: 'Just now' },
      { agentName: 'Resolver Agent', status: 'pending', message: 'Drafting grounded policy resolution...', timestamp: 'Just now' },
      { agentName: 'Critic Agent', status: 'pending', message: 'Evaluating confidence & guardrails...', timestamp: 'Just now' },
      { agentName: 'Manager Agent', status: 'pending', message: 'Deciding routing & exit condition...', timestamp: 'Just now' },
      { agentName: 'Action Agent', status: 'pending', message: 'Executing approved backend action...', timestamp: 'Just now' },
    ];
    setActiveSteps(initialSteps);

    try {
      const accessToken = await getAccessToken();

      // Call Azure Container App Backend
      const response = await fetch(`${BACKEND_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ message: userText, user_id: 'CUST-8801', channel: 'chat' }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // Update reasoning steps from API
      if (data.reasoning_steps && Array.isArray(data.reasoning_steps)) {
        const updatedSteps: MultiAgentStep[] = data.reasoning_steps.map((stepStr: string, idx: number) => {
          const names: MultiAgentStep['agentName'][] = ['Intake Agent', 'Triage Agent', 'RAG Agent', 'Resolver Agent', 'Critic Agent', 'Manager Agent', 'Action Agent'];
          return {
            agentName: names[idx % names.length],
            status: 'completed',
            message: stepStr,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          };
        });
        setActiveSteps(updatedSteps);
      }

      const conf = data.confidence || 92;
      setConfidenceScore(conf);
      if (data.loop_metadata) {
        setLoopMetadata(data.loop_metadata);
      }

      // AI Response Message
      const aiMsg: ChatMessage = {
        id: `msg-${Date.now()}-ai`,
        sender: 'ai',
        senderName: 'AI Support Agent',
        text: data.resolution || 'Resolution generated successfully.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        confidenceScore: conf,
        agentSteps: activeSteps,
        kbCitations: (data.sources || []).map((src: string, idx: number) => ({
          id: `kb-${idx}`,
          title: src,
          linkText: src,
        })),
        actionExecuted: data.action_type,
        loopMetadata: data.loop_metadata,
        ticketNumber: data.ticket_number,
        requestType: data.request_type,
      };

      setMessages((prev) => [...prev, aiMsg]);

      // Ticket Creation - use the real SRV/INC number the backend assigned at
      // Intake (classified straight from the customer's message), not a
      // locally faked id.
      const newTicket: Ticket = {
        id: data.ticket_number || (data.ticket_id ? `TCK-${data.ticket_id.slice(0, 4).toUpperCase()}` : `TCK-${Math.floor(4500 + Math.random() * 400)}`),
        subject: userText.slice(0, 50),
        description: userText,
        category: 'Support',
        channel: 'chat',
        priority: conf < 75 ? 'High' : 'Medium',
        status: data.status === 'pending_human' ? 'Pending Approval' : 'Resolved',
        customer: {
          id: 'CUST-8801',
          name: 'Alex Mercer',
          email: 'alex.mercer@acmecorp.com',
          company: 'Acme Corp',
          tier: 'Enterprise',
          priorTicketsCount: 3,
        },
        assignedAgent: 'AI Support Agent',
        createdTime: 'Just now',
        lastUpdated: 'Just now',
        confidenceScore: conf,
        conversationHistory: [userMsg, aiMsg],
      };

      onTicketCreatedOrUpdated(newTicket);

    } catch (err: any) {
      console.error('API Chat Error:', err);

      // Was this a real backend/pipeline failure, or just an auth hiccup on
      // our side (popup blocked, silent renewal timed out)? These need
      // different messages - an auth failure is fixed by clicking Send
      // again (a fresh click gives the browser a real user gesture, so the
      // popup fallback in getAccessToken() will actually be allowed to open
      // this time), a backend failure is not. Previously both cases showed
      // an identical fabricated "processed successfully, 88% confidence"
      // message, which silently hid genuine failures - including auth ones -
      // behind a fake success state. Never do that again: an error state
      // must look like an error state.
      const isAuthError = err?.name === 'BrowserAuthError' || err?.errorCode?.includes?.('popup') || err?.errorCode === 'timed_out';

      const errorMsg: ChatMessage = {
        id: `msg-${Date.now()}-err`,
        sender: 'ai',
        senderName: 'AI Support Agent',
        text: isAuthError
          ? 'Your sign-in expired. Redirecting you to sign in again - after you return, send your message again.'
          : `Sorry, something went wrong reaching the support agent (${err?.message || 'unknown error'}). Please try again in a moment.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        // No fabricated confidenceScore here - this is an error state, it
        // must not look like a successful, confident resolution.
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
      {/* Left: Chat Container */}
      <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col h-[750px] shadow-2xl overflow-hidden">
        {/* Chat Header */}
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-950/60 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <Bot className="w-6 h-6" />
            </div>
            <div>
              <h2 className="font-semibold text-slate-100 flex items-center space-x-2">
                <span>Enterprise Support Agent</span>
                <span className="px-2 py-0.5 text-xs rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 font-mono">
                  Azure OpenAI Live
                </span>
              </h2>
              <p className="text-xs text-slate-400">Multi-Agent Orchestrator + RAG Policy Grounding</p>
            </div>
          </div>
        </div>

        {/* Chat Messages Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex items-start space-x-3 ${
                msg.sender === 'user' ? 'flex-row-reverse space-x-reverse' : ''
              }`}
            >
              <div
                className={`w-9 h-9 rounded-xl flex items-center justify-center text-sm font-semibold shrink-0 ${
                  msg.sender === 'user'
                    ? 'bg-gradient-to-br from-cyan-500 to-blue-600 text-slate-950'
                    : 'bg-slate-800 text-cyan-400 border border-slate-700'
                }`}
              >
                {msg.sender === 'user' ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
              </div>

              <div className="space-y-2 max-w-xl">
                <div
                  className={`p-4 rounded-2xl text-sm leading-relaxed ${
                    msg.sender === 'user'
                      ? 'bg-cyan-600 text-white rounded-tr-none'
                      : 'bg-slate-800/90 text-slate-200 border border-slate-700/80 rounded-tl-none'
                  }`}
                >
                  {msg.ticketNumber && (
                    <div className="mb-2.5 flex items-center space-x-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider rounded border ${
                          msg.requestType === 'service_request'
                            ? 'bg-violet-500/10 text-violet-300 border-violet-500/30'
                            : 'bg-orange-500/10 text-orange-300 border-orange-500/30'
                        }`}
                      >
                        {msg.requestType === 'service_request' ? 'Service Request' : 'Incident'}
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">{msg.ticketNumber}</span>
                    </div>
                  )}
                  <p className="whitespace-pre-line">{msg.text}</p>

                  {/* Simulated-action disclosure - the LLM calls, RAG retrieval,
                      classification and guardrails above are all real; this
                      specific backend action is mocked since it needs an
                      Intune-enrolled device / real IT service catalog we
                      don't have wired up for the demo. */}
                  {(msg.actionExecuted === 'run_device_diagnostic' || msg.actionExecuted === 'provision_access') && (
                    <div className="mt-3 flex items-start space-x-1.5 text-[11px] text-amber-300/90 bg-amber-500/5 border border-amber-500/20 rounded-lg px-2.5 py-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>
                        Simulated action — this step shows the real Microsoft Graph/Intune call
                        shape but isn't wired to an actual managed device in this demo.
                      </span>
                    </div>
                  )}

                  {/* Citations */}
                  {msg.kbCitations && msg.kbCitations.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-700/60 flex flex-wrap gap-2">
                      {msg.kbCitations.map((citation) => (
                        <span
                          key={citation.id}
                          className="inline-flex items-center space-x-1.5 px-2.5 py-1 text-xs rounded-md bg-slate-900/80 text-cyan-300 border border-cyan-500/20"
                        >
                          <FileText className="w-3 h-3 text-cyan-400" />
                          <span>{citation.title}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center space-x-2 text-[11px] text-slate-400 px-1">
                  <span>{msg.senderName}</span>
                  <span>•</span>
                  <span>{msg.timestamp}</span>
                  {msg.confidenceScore !== undefined && (
                    <>
                      <span>•</span>
                      <span className="text-cyan-400 font-mono font-medium">
                        {msg.confidenceScore}% Confidence
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}

          {isProcessing && (
            <div className="flex items-center space-x-3">
              <div className="w-9 h-9 rounded-xl bg-slate-800 text-cyan-400 border border-slate-700 flex items-center justify-center">
                <Bot className="w-5 h-5 animate-pulse" />
              </div>
              <div className="bg-slate-800/80 border border-slate-700/80 p-4 rounded-2xl rounded-tl-none text-slate-300 text-sm flex items-center space-x-3">
                <Sparkles className="w-4 h-4 text-cyan-400 animate-spin" />
                <span>Agents executing multi-step reasoning workflow...</span>
              </div>
            </div>
          )}
        </div>

        {/* Input Bar */}
        <form onSubmit={handleSendMessage} className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center space-x-3">
          <input
            type="text"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            placeholder="Type your support query (e.g. I cannot reset my password or VPN connection error)..."
            className="flex-1 bg-slate-900 border border-slate-700/80 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
          />
          <button
            type="submit"
            disabled={!inputMessage.trim() || isProcessing}
            className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-semibold px-5 py-3 rounded-xl flex items-center space-x-2 transition-all shadow-lg shadow-cyan-500/20"
          >
            <span>Send</span>
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>

      {/* Right: Reasoning & Telemetry Panel */}
      <div className="space-y-6">
        {/* Agent Reasoning Panel */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
          <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
            <h3 className="font-semibold text-slate-200 flex items-center space-x-2">
              <Sparkles className="w-4 h-4 text-cyan-400" />
              <span>Multi-Agent Reasoning Trace</span>
            </h3>
            <span className="text-xs font-mono text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
              Live Loop
            </span>
          </div>

          <div className="space-y-3">
            {activeSteps.length === 0 ? (
              <p className="text-xs text-slate-400 italic">Submit a message to view live agent steps.</p>
            ) : (
              activeSteps.map((step, idx) => (
                <div key={idx} className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 text-xs space-y-1">
                  <div className="flex items-center justify-between font-mono font-medium text-slate-300">
                    <span className="text-cyan-400">{step.agentName}</span>
                    <span className="text-[10px] text-slate-400">{step.timestamp}</span>
                  </div>
                  <p className="text-slate-400 leading-relaxed">{step.message}</p>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Confidence & Guardrails Panel */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
          <h3 className="font-semibold text-slate-200 mb-4 pb-3 border-b border-slate-800 flex items-center justify-between">
            <span>Critic & Guardrails</span>
            {confidenceScore !== null && (
              <span className="font-mono text-cyan-400 text-sm">{confidenceScore}%</span>
            )}
          </h3>

          <div className="space-y-3 text-xs text-slate-400">
            <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/50 border border-slate-800">
              <span>Auto-Resolve Threshold</span>
              <span className="font-mono text-slate-300">≥ 75%</span>
            </div>
            <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/50 border border-slate-800">
              <span>RAG Policy Grounding</span>
              <span className="text-emerald-400 font-medium flex items-center space-x-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Verified</span>
              </span>
            </div>
            <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-950/50 border border-slate-800">
              <span>Azure Content Safety</span>
              <span className="text-emerald-400 font-medium flex items-center space-x-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Passed</span>
              </span>
            </div>
          </div>
        </div>

        {/* Loop Engineering Panel - the actual mechanics behind the agent-to-agent
            calls above: shared state carried turn-by-turn, the hard max-turns cap,
            which guardrails fired, and which explicit exit condition was hit. */}
        {loopMetadata && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
            <h3 className="font-semibold text-slate-200 mb-4 pb-3 border-b border-slate-800 flex items-center space-x-2">
              <ArrowRight className="w-4 h-4 text-cyan-400" />
              <span>Loop Engineering</span>
            </h3>

            <div className="space-y-4 text-xs">
              <div>
                <div className="flex items-center justify-between text-slate-400 mb-1.5">
                  <span>Agent-to-agent turns</span>
                  <span className="font-mono text-slate-300">
                    {loopMetadata.turn_count} / {loopMetadata.max_turns}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${loopMetadata.max_turns_reached ? 'bg-amber-400' : 'bg-cyan-500'}`}
                    style={{ width: `${Math.min(100, (loopMetadata.turn_count / loopMetadata.max_turns) * 100)}%` }}
                  />
                </div>
              </div>

              <div>
                <p className="text-slate-400 mb-1.5">Guardrails evaluated</p>
                {loopMetadata.guardrail_flags.length === 0 ? (
                  <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>None triggered - clean path</span>
                  </span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {loopMetadata.guardrail_flags.map((flag, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono"
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        <span>{flag}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="p-2.5 rounded-lg bg-slate-950/50 border border-slate-800">
                <p className="text-slate-400 mb-1">Exit condition reached</p>
                <p className="text-slate-200 font-medium">{loopMetadata.exit_condition_label}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
