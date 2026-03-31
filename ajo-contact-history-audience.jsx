import { useState, useCallback, useMemo } from "react";

// ═══════════════════════════════════════════════════════════════
// AJO CONTACT HISTORY AUDIENCE BUILDER — V2.1
// Production-validated SQL for AEP Query Service (Spark SQL)
//
// CORRECTIONS from production testing:
// 1. UNNEST → COALESCE + array index on identityMap
// 2. Added isTestExecution IS NULL filter
// 3. Added messageID IS NOT NULL guard
// 4. Journey/campaign name matching uses LIKE (exact = fails)
// 5. Treatment names are user input (not hardcoded A/B)
// 6. Removed non-existent campaign.campaignActionName
// 7. Flat query (no subquery-then-unnest)
// ═══════════════════════════════════════════════════════════════

const CHANNEL_MAP = {
  EM: { label: "Email", uri: "https://ns.adobe.com/xdm/channels/email" },
  PU: { label: "Push", uri: "https://ns.adobe.com/xdm/channels/push" },
  SM: { label: "SMS", uri: "https://ns.adobe.com/xdm/channels/sms" },
  DM: { label: "Direct Mail", uri: "https://ns.adobe.com/xdm/channels/directMail" },
};

const FLAVOR_MAP = {
  target: { label: "Target (Sent)", desc: "Profiles who received the message" },
  holdout: { label: "Control / Holdout", desc: "ExperimentationHoldoutExclusion (050018)" },
  variant: { label: "Experiment Variant", desc: "Specific treatment — enter name below" },
  all_sent: { label: "All Sent", desc: "All sent, any variant" },
  bounced: { label: "Bounced", desc: "Delivery bounced" },
};

const SOURCE_MAP = {
  journey: { label: "Journey", nameField: "entities.journey.journeyName", versionField: "entities.journey.journeyVersionID", hasAction: true, actionField: "entities.journey.journeyActionName" },
  campaign: { label: "Campaign", nameField: "entities.campaign.name", versionField: "entities.campaign.campaignVersionID", hasAction: false },
};

const EXCLUSION_CODES = [
  { code: "050018", name: "ExperimentationHoldoutExclusion", desc: "Holdout arm of experiment" },
  { code: "050002", name: "ExcludedForControlRules", desc: "Frequency cap / control rule" },
  { code: "050027", name: "EmailNoMessageFoundForTreatment", desc: "No email message for treatment" },
  { code: "050036", name: "PushNoMessageFoundForTreatment", desc: "No push message for treatment" },
  { code: "050017", name: "ExperimentNamespaceMismatch", desc: "Namespace mismatch" },
];

const FEEDBACK_STATUSES = ["sent", "bounce", "delay", "error", "exclude", "delivered", "retry"];
const P = "_experience.customerJourneyManagement";

function identitySelect(ns) {
  return `COALESCE(\n        MF.identityMap['${ns}'][0].id,\n        MF.identityMap['${ns.toLowerCase()}'][0].id\n    ) AS partner_id`;
}

function generateSQL(config) {
  const { source, channel, flavor, entityName, audienceName, identityNs, dateFrom, dateTo, treatmentName, queryType } = config;
  const ch = CHANNEL_MAP[channel];
  const src = SOURCE_MAP[source];
  const ns = identityNs || "vtflPartnerid";
  const aud = audienceName || "contact_history_audience";

  const wheres = [];
  wheres.push(`    -- Filter: exclude test/seed executions\n    MF.${P}.messageProfile.isTestExecution IS NULL`);
  wheres.push(`    -- Filter: guard against null messageID joins\n    MF.${P}.messageExecution.messageID IS NOT NULL`);
  wheres.push(`    AE.${P}.entities.channelDetails.channel._id\n      = '${ch.uri}'`);
  wheres.push(`    AE.${P}.${src.versionField} IS NOT NULL`);
  if (entityName) {
    wheres.push(`    -- LIKE used because exact match (=) is unreliable in AJO Entity Dataset\n    AE.${P}.${src.nameField}\n      LIKE '%${entityName}%'`);
  }
  if (flavor === "target" || flavor === "all_sent") {
    wheres.push(`    MF.${P}.messageDeliveryfeedback.feedbackStatus = 'sent'`);
  } else if (flavor === "holdout") {
    wheres.push(`    MF.${P}.messageDeliveryfeedback.feedbackStatus = 'exclude'`);
    wheres.push(`    MF.${P}.messageDeliveryfeedback.messageExclusion.reason = 'ExperimentationHoldoutExclusion'`);
  } else if (flavor === "variant") {
    wheres.push(`    MF.${P}.messageDeliveryfeedback.feedbackStatus = 'sent'`);
    wheres.push(`    AE.${P}.entities.experiment.treatmentName IS NOT NULL`);
    if (treatmentName) wheres.push(`    AE.${P}.entities.experiment.treatmentName = '${treatmentName}'`);
  } else if (flavor === "bounced") {
    wheres.push(`    MF.${P}.messageDeliveryfeedback.feedbackStatus = 'bounce'`);
  }
  if (dateFrom) wheres.push(`    MF.timestamp >= '${dateFrom}T00:00:00.000Z'`);
  if (dateTo) wheres.push(`    MF.timestamp <= '${dateTo}T23:59:59.999Z'`);
  if (!dateFrom && !dateTo) wheres.push(`    MF.timestamp >= CURRENT_DATE - INTERVAL '90' DAY`);

  const whereClause = wheres.join("\n    AND ");
  const joinBlock = `FROM ajo_entity_dataset AE\nINNER JOIN ajo_message_feedback_event_dataset MF\n    ON AE.${P}.entities.channelDetails.messageID\n     = MF.${P}.messageExecution.messageID\nWHERE\n${whereClause}`;

  if (queryType === "discovery") {
    return `-- DISCOVERY: What journeys/campaigns/treatments exist?\nSELECT\n    AE.${P}.entities.journey.journeyName         AS journey_name,\n    AE.${P}.entities.journey.journeyActionName    AS action_name,\n    AE.${P}.entities.channelDetails.channel._id   AS channel,\n    AE.${P}.entities.experiment.experimentName    AS experiment,\n    AE.${P}.entities.experiment.treatmentName     AS treatment,\n    COUNT(DISTINCT AE.${P}.entities.channelDetails.messageID) AS message_count\nFROM ajo_entity_dataset AE\nWHERE\n    AE.${P}.entities.journey.journeyVersionID IS NOT NULL\n    AND AE.${P}.entities.journey.journeyName IS NOT NULL\nGROUP BY 1, 2, 3, 4, 5\nORDER BY message_count DESC;`;
  }

  if (queryType === "exploratory") {
    const nameAlias = source === "journey" ? "journey_name" : "campaign_name";
    const cols = [`    AE.${P}.${src.nameField}  AS ${nameAlias}`];
    if (src.hasAction) cols.push(`    AE.${P}.${src.actionField}  AS action_name`);
    cols.push(
      `    AE.${P}.entities.experiment.experimentName   AS experiment_name`,
      `    AE.${P}.entities.experiment.treatmentName     AS treatment_name`,
      `    AE.${P}.entities.channelDetails.variantName   AS variant_name`,
      `    MF.${P}.messageDeliveryfeedback.feedbackStatus AS feedback_status`,
      `    MF.timestamp AS event_timestamp`,
      `    MF.${P}.messageExecution.batchInstanceID AS batch_id`,
    );
    return `-- EXPLORATORY: ${src.label} | ${ch.label} | ${FLAVOR_MAP[flavor].label}\n-- Generated: ${new Date().toISOString().split("T")[0]}\n\nSELECT\n${cols.join(",\n")},\n    ${identitySelect(ns)},\n    COUNT(*) AS cnt\n${joinBlock}\nGROUP BY ${Array.from({length: cols.length + 1}, (_, i) => i + 1).join(", ")}\nORDER BY cnt DESC\nLIMIT 200;`;
  }

  // Audience query
  const header = `-- DATA DISTILLER AUDIENCE: ${aud}\n-- ${src.label} | ${ch.label} | ${FLAVOR_MAP[flavor].label}\n-- Generated: ${new Date().toISOString().split("T")[0]}`;
  const sel = `SELECT DISTINCT\n    ${identitySelect(ns)}`;

  return `${header}\n\n-- STEP 1: Create (run once)\nCREATE AUDIENCE ${aud}\nWITH (primary_identity='partner_id', identity_namespace='${ns}')\nAS (\n${sel}\n${joinBlock}\n);\n\n-- STEP 2: Refresh (schedule before 30-day TTL expiry)\n-- INSERT OVERWRITE INTO ${aud}\n-- ${sel.split("\n").map(l => "-- " + l).join("\n")}\n-- ${joinBlock.split("\n").map(l => "-- " + l).join("\n")}\n-- ;\n\n-- NOTES:\n-- * 30-day auto-deletion TTL\n-- * COALESCE handles identity namespace case sensitivity\n-- * isTestExecution IS NULL excludes test/seed sends\n-- * messageID IS NOT NULL prevents false JOIN matches\n-- * LIKE on names handles whitespace/encoding`;
}

// ─── UI ───
export default function AJOQueryBuilder() {
  const [source, setSource] = useState("journey");
  const [channel, setChannel] = useState("EM");
  const [flavor, setFlavor] = useState("target");
  const [entityName, setEntityName] = useState("");
  const [audienceName, setAudienceName] = useState("");
  const [identityNs, setIdentityNs] = useState("vtflPartnerid");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [treatmentName, setTreatmentName] = useState("");
  const [queryType, setQueryType] = useState("audience");
  const [activeTab, setActiveTab] = useState("generator");
  const [copied, setCopied] = useState(false);

  const sql = useMemo(() => generateSQL({ source, channel, flavor, entityName, audienceName, identityNs, dateFrom, dateTo, treatmentName, queryType }), [source, channel, flavor, entityName, audienceName, identityNs, dateFrom, dateTo, treatmentName, queryType]);

  const copy = useCallback(() => { navigator.clipboard.writeText(sql).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }, [sql]);

  const C = { bg: "#0a0e17", panel: "#0f1729", card: "#131b2e", border: "#1e2d4a", accent: "#eb1000", text: "#c8d6e5", bright: "#e8f0fe", muted: "#5a7a9a", dim: "#4a6a8a", green: "#75e6a0", red: "#e67575", amber: "#e6c875", blue: "#8ab4d8" };

  const tabs = [{ id: "generator", label: "Query Generator" }, { id: "research", label: "Research Findings" }, { id: "reference", label: "Field Reference" }];

  return (
    <div style={{ fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace", background: C.bg, color: C.text, minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ background: "linear-gradient(135deg, #0f1729 0%, #1a1040 50%, #0d1f3c 100%)", borderBottom: `1px solid ${C.border}`, padding: "24px 32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 8, background: "linear-gradient(135deg, #eb1000 0%, #ff4d2a 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 800, color: "white" }}>A</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#f0f4f8", letterSpacing: "-0.02em" }}>AJO Contact History Audience Builder</h1>
            <p style={{ margin: "2px 0 0", fontSize: 11, color: C.muted, letterSpacing: "0.05em", textTransform: "uppercase" }}>Data Distiller · Query Service · Production-Validated SQL</p>
          </div>
        </div>
      </div>

      {/* Tab Bar */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, background: "#0d1220" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{ padding: "12px 24px", background: activeTab === t.id ? C.card : "transparent", color: activeTab === t.id ? C.bright : C.dim, border: "none", borderBottom: activeTab === t.id ? `2px solid ${C.accent}` : "2px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>{t.label}</button>
        ))}
      </div>

      <div style={{ padding: "24px 32px", maxWidth: 1200, margin: "0 auto" }}>
        {activeTab === "generator" && (
          <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 24 }}>
            {/* Controls */}
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <Label>Output Type</Label>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {[{ id: "discovery", label: "Discovery", desc: "Find journeys, treatments" }, { id: "exploratory", label: "Exploratory", desc: "Investigate with metadata" }, { id: "audience", label: "Audience", desc: "CREATE AUDIENCE for AJO" }].map(qt => (
                    <Pill key={qt.id} active={queryType === qt.id} onClick={() => setQueryType(qt.id)} wide>{qt.label} — <span style={{ color: C.muted, fontSize: 10 }}>{qt.desc}</span></Pill>
                  ))}
                </div>
              </div>

              {queryType !== "discovery" && (<>
                <div>
                  <Label>Source Type</Label>
                  <div style={{ display: "flex", gap: 8 }}>
                    {Object.entries(SOURCE_MAP).map(([k, v]) => (<Pill key={k} active={source === k} onClick={() => setSource(k)}>{v.label}</Pill>))}
                  </div>
                </div>

                <div>
                  <Label>Channel</Label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {Object.entries(CHANNEL_MAP).map(([k, v]) => (<Pill key={k} active={channel === k} onClick={() => setChannel(k)}>{v.label}</Pill>))}
                  </div>
                </div>

                <div>
                  <Label>Flavor</Label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {Object.entries(FLAVOR_MAP).map(([k, v]) => (<Pill key={k} active={flavor === k} onClick={() => setFlavor(k)} wide>{v.label} — <span style={{ color: C.muted, fontSize: 10 }}>{v.desc}</span></Pill>))}
                  </div>
                </div>

                {flavor === "variant" && (
                  <div>
                    <Label>Treatment Name</Label>
                    <Input value={treatmentName} onChange={e => setTreatmentName(e.target.value)} placeholder="from discovery query" />
                    <Hint>Run Discovery query first to find treatment names.</Hint>
                  </div>
                )}

                <div>
                  <Label>{source === "journey" ? "Journey Name" : "Campaign Name"} (optional)</Label>
                  <Input value={entityName} onChange={e => setEntityName(e.target.value)} placeholder={source === "journey" ? "e.g. Welcome Journey" : "e.g. Spring Sale"} />
                  <Hint>Uses LIKE with wildcards. Exact match (=) is unreliable.</Hint>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div><Label>From</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></div>
                  <div><Label>To</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} /></div>
                </div>
                <Hint>Defaults to last 90 days if empty.</Hint>

                {queryType === "audience" && (
                  <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
                    <Label>Identity Namespace</Label>
                    <Input value={identityNs} onChange={e => setIdentityNs(e.target.value)} />
                    <Hint>COALESCE handles both case variants automatically.</Hint>
                    <div style={{ marginTop: 12 }}><Label>Audience Name</Label><Input value={audienceName} onChange={e => setAudienceName(e.target.value)} placeholder="e.g. welcome_nl_email_sent" /></div>
                  </div>
                )}
              </>)}
            </div>

            {/* SQL Output */}
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: "#0d1220", borderBottom: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  {queryType === "discovery" ? "Discovery Query" : queryType === "exploratory" ? "Exploratory Query" : "Audience SQL"}
                </span>
                <button onClick={copy} style={{ padding: "6px 14px", background: copied ? "#0f5132" : C.border, color: copied ? C.green : C.blue, border: "none", borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit" }}>{copied ? "\u2713 Copied" : "Copy SQL"}</button>
              </div>
              <div style={{ padding: "6px 16px", background: C.card, borderBottom: `1px solid ${C.border}`, fontSize: 10, color: C.muted }}>
                <strong style={{ color: C.green }}>Production-validated:</strong> COALESCE identity · isTestExecution filter · messageID NOT NULL · LIKE matching · Flat query
              </div>
              <pre style={{ flex: 1, margin: 0, padding: 16, fontSize: 11.5, lineHeight: 1.7, color: C.blue, background: C.bg, overflow: "auto", whiteSpace: "pre-wrap", fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>{sql}</pre>
            </div>
          </div>
        )}

        {activeTab === "research" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 900 }}>
            <RCard title="1. UNNEST → COALESCE + Array Index" status="fix">
              <p><code>UNNEST(identityMap['vtflPartnerid'])</code> fails in AEP Query Service (Spark SQL). Use:</p>
              <Code>{`COALESCE(\n    MF.identityMap['vtflPartnerid'][0].id,\n    MF.identityMap['vtflpartnerid'][0].id\n) AS partner_id`}</Code>
              <p>COALESCE handles case sensitivity differences in namespace key.</p>
            </RCard>
            <RCard title="2. Mandatory Production Safety Filters" status="fix">
              <Code>{`MF.${P}.messageProfile.isTestExecution IS NULL\nMF.${P}.messageExecution.messageID IS NOT NULL`}</Code>
              <p>First filter excludes test/seed sends. Second prevents false JOIN matches on null messageIDs.</p>
            </RCard>
            <RCard title="3. LIKE Matching for Names" status="fix">
              <p>Exact match (<code>=</code>) returns 0 rows even for existing journeys. Journey names can contain whitespace/encoding differences. <code>LIKE '%name%'</code> works correctly.</p>
            </RCard>
            <RCard title="4. Treatment Names Are Environment-Specific" status="fix">
              <p>Not standardized as "Treatment A/B". Run Discovery query to find actual values.</p>
            </RCard>
            <RCard title="5. No campaign.campaignActionName Field" status="fix">
              <p>This field does not exist. Campaigns have <code>campaign.name</code> and <code>campaign.campaignVersionID</code> only. Action name concept is journey-specific.</p>
            </RCard>
            <RCard title="6. Canonical messageID Join" status="verified">
              <Code>{`AE...entities.channelDetails.messageID\n = MF...messageExecution.messageID`}</Code>
              <p>Each experiment treatment has a unique messageID (XDM confirmed). Batch journeys may need <code>batchInstanceID</code> for disambiguation.</p>
            </RCard>
            <RCard title="7. 30-Day TTL on Data Distiller Audiences" status="verified">
              <p>Auto-deleted after 30 days. Refresh via <code>INSERT OVERWRITE INTO</code> on schedule shorter than 30 days.</p>
            </RCard>
            <RCard title="8. Holdout Detection" status="verified">
              <p><code>feedbackStatus = 'exclude'</code> + <code>messageExclusion.reason = 'ExperimentationHoldoutExclusion'</code> (code 050018).</p>
            </RCard>
            <RCard title="9. Adobe Docs May Not Work" status="warning">
              <p>Several SQL patterns from Experience League fail in AEP Query Service. Always test before production use. Entity dataset has duplicate entries per message (use DISTINCT).</p>
            </RCard>
          </div>
        )}

        {activeTab === "reference" && (
          <div style={{ maxWidth: 900 }}>
            <h2 style={{ fontSize: 16, color: C.bright, marginBottom: 16, fontWeight: 700 }}>Field Paths</h2>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
              <thead><tr style={{ borderBottom: `2px solid ${C.border}` }}>
                {["Field", "Dataset", "Path"].map(h => (<th key={h} style={{ textAlign: "left", padding: "10px 12px", color: C.muted, fontWeight: 700, textTransform: "uppercase", fontSize: 10 }}>{h}</th>))}
              </tr></thead>
              <tbody>
                {[
                  ["Message ID (entity)", "entity", "...entities.channelDetails.messageID"],
                  ["Message ID (feedback)", "feedback", "...messageExecution.messageID"],
                  ["Journey Name", "entity", "...entities.journey.journeyName"],
                  ["Journey Action", "entity", "...entities.journey.journeyActionName"],
                  ["Campaign Name", "entity", "...entities.campaign.name"],
                  ["Channel (entity)", "entity", "...entities.channelDetails.channel._id"],
                  ["Feedback Status", "feedback", "...messageDeliveryfeedback.feedbackStatus"],
                  ["Exclusion Reason", "feedback", "...messageDeliveryfeedback.messageExclusion.reason"],
                  ["Is Test Execution", "feedback", "...messageProfile.isTestExecution"],
                  ["Batch Instance ID", "feedback", "...messageExecution.batchInstanceID"],
                  ["Treatment Name", "entity", "...entities.experiment.treatmentName"],
                  ["Experiment Name", "entity", "...entities.experiment.experimentName"],
                  ["Variant Name", "entity", "...entities.channelDetails.variantName"],
                  ["Email Subject", "entity", "...entities.channelDetails.email.subject"],
                ].map(([f, d, p], i) => (
                  <tr key={i} style={{ borderBottom: `1px solid #141e30`, background: i % 2 === 0 ? "transparent" : "#0d1220" }}>
                    <td style={{ padding: "8px 12px", color: C.bright, fontWeight: 600 }}>{f}</td>
                    <td style={{ padding: "8px 12px", color: "#5a9a7a" }}>{d}</td>
                    <td style={{ padding: "8px 12px", color: C.blue, fontSize: 10 }}><code>{p}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h2 style={{ fontSize: 16, color: C.bright, margin: "32px 0 16px", fontWeight: 700 }}>Status Values</h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {FEEDBACK_STATUSES.map(s => (
                <span key={s} style={{ padding: "4px 12px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, color: s === "sent" ? C.green : s === "bounce" ? C.red : s === "exclude" ? C.amber : C.blue, fontWeight: 600 }}>{s}</span>
              ))}
            </div>

            <h2 style={{ fontSize: 16, color: C.bright, margin: "32px 0 16px", fontWeight: 700 }}>Exclusion Codes</h2>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ borderBottom: `2px solid ${C.border}` }}>
                {["Code", "Reason", "Desc"].map(h => (<th key={h} style={{ textAlign: "left", padding: "10px 12px", color: C.muted, fontWeight: 700, fontSize: 10 }}>{h}</th>))}
              </tr></thead>
              <tbody>
                {EXCLUSION_CODES.map((ec, i) => (
                  <tr key={ec.code} style={{ borderBottom: `1px solid #141e30`, background: i % 2 === 0 ? "transparent" : "#0d1220" }}>
                    <td style={{ padding: "8px 12px", color: C.amber, fontWeight: 600 }}>{ec.code}</td>
                    <td style={{ padding: "8px 12px", color: C.bright }}>{ec.name}</td>
                    <td style={{ padding: "8px 12px", color: C.blue }}>{ec.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Label({ children }) { return <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "#5a7a9a", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>{children}</label>; }
function Input(props) { return <input {...props} style={{ padding: "8px 12px", background: "#0a0e17", border: "1px solid #1e2d4a", borderRadius: 4, color: "#c8d6e5", fontSize: 12, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box", ...props.style }} />; }
function Hint({ children }) { return <p style={{ margin: "4px 0 0", fontSize: 10, color: "#4a6a8a", lineHeight: 1.4 }}>{children}</p>; }
function Pill({ children, active, onClick, wide }) { return <button onClick={onClick} style={{ padding: wide ? "6px 12px" : "6px 14px", background: active ? "#1a2744" : "transparent", color: active ? "#e8f0fe" : "#4a6a8a", border: `1px solid ${active ? "#2a4a6a" : "#1e2d4a"}`, borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit", textAlign: "left", flex: wide ? "1 1 100%" : undefined, transition: "all 0.15s" }}>{children}</button>; }
function Code({ children }) { return <pre style={{ background: "#0a0e17", border: "1px solid #141e30", borderRadius: 4, padding: "10px 14px", margin: "8px 0", fontSize: 11, lineHeight: 1.6, color: "#8ab4d8", overflow: "auto", whiteSpace: "pre-wrap" }}>{children}</pre>; }
function RCard({ title, status, children }) {
  const m = { verified: { b: "#1a4a1a", c: "#75e6a0", bg: "#0f2f0f", t: "VERIFIED" }, warning: { b: "#4a3a1a", c: "#e6c875", bg: "#2f2a0f", t: "CAUTION" }, fix: { b: "#4a1a1a", c: "#e67575", bg: "#2f0f0f", t: "PRODUCTION FIX" } };
  const s = m[status] || m.verified;
  return (
    <div className="rc" style={{ background: "#0f1729", border: `1px solid ${s.b}`, borderRadius: 8, padding: 20, fontSize: 13, lineHeight: 1.8, color: "#a0b8d0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: "#e8f0fe", fontWeight: 700 }}>{title}</h3>
        <span style={{ padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 800, background: s.bg, color: s.c, letterSpacing: "0.1em" }}>{s.t}</span>
      </div>
      {children}
      <style>{`.rc p{margin:6px 0}.rc code{background:#0a0e17;padding:1px 5px;border-radius:3px;font-size:11.5px;color:#8ab4d8}.rc strong{color:#c8dce8}`}</style>
    </div>
  );
}
