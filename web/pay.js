// Browser client: connect a wallet, pay over x402 (gasless EIP-3009 signature), render the report.
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createWalletClient, custom } from "viem";
import { celo } from "viem/chains";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === "class" ? (n.className = v) : n.setAttribute(k, v);
  for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(String(k ?? "")));
  return n; // text only via textContent/createTextNode: report content comes from third parties
};
const scan = (tx) => `https://celoscan.io/tx/${tx}`;
let account, walletClient;

function status(msg, kind = "") { const s = $("status"); s.textContent = msg; s.className = "status " + kind; }

async function connect() {
  const eth = window.ethereum;
  if (!eth) return status("No wallet found. Install MetaMask or open this page inside MiniPay.", "err");
  try {
    const [addr] = await eth.request({ method: "eth_requestAccounts" });
    try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa4ec" }] }); }
    catch (e) {
      if (e?.code === 4902) await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0xa4ec", chainName: "Celo", nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 }, rpcUrls: ["https://forno.celo.org"], blockExplorerUrls: ["https://celoscan.io"] }] });
      else throw e;
    }
    account = addr;
    walletClient = createWalletClient({ account: addr, chain: celo, transport: custom(eth) });
    $("connect").textContent = `Connected: ${addr.slice(0, 6)}…${addr.slice(-4)}`;
    $("pay").disabled = false;
    status("Wallet connected on Celo. Fill the form and pay.", "ok");
  } catch (e) { status("Could not connect: " + (e?.shortMessage || e?.message || e), "err"); }
}

function formBody() {
  const body = { project: $("project").value.trim() };
  const h = $("handle").value.trim(); if (h) body.handle = h;
  const kw = $("keywords").value.split(",").map((s) => s.trim()).filter(Boolean); if (kw.length) body.keywords = kw;
  const f = $("focus").value; if (f) body.focusRegion = f;
  return body;
}

async function pay() {
  const body = formBody();
  if (body.project.length < 2) return status("Enter the project name.", "err");
  $("pay").disabled = true; $("report").replaceChildren();
  try {
    // The wallet signs locally; nothing is sent until the user approves the typed-data prompt.
    const signer = { address: account, signTypedData: (m) => walletClient.signTypedData({ account, ...m }) };
    const client = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
    status("Approve the payment in your wallet (a signature, no gas). The agent then buys live data and analyses it. This takes a few minutes (about 2), so please keep this tab open.", "");
    const res = await wrapFetchWithPayment(fetch, client)("/api/audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const header = res.headers.get("payment-response");
    const settlement = header ? JSON.parse(atob(header)) : null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      status(res.status === 402 ? "Payment was not completed. You were not charged." : `No report (${res.status}): ${json.error || "unknown error"}. If the payment did not settle you were not charged.`, "err");
      return;
    }
    status("Paid and delivered.", "ok");
    render(json, settlement);
  } catch (e) { status("Payment cancelled or failed: " + (e?.shortMessage || e?.message || e), "err"); }
  finally { $("pay").disabled = false; }
}

function section(title, ...kids) { return el("section", { class: "card" }, el("h2", {}, title), ...kids); }

function render(j, settlement) {
  const r = j.report, root = $("report");
  root.append(section(`${r.project}: ${r.score}/100, ${r.band}`, el("p", {}, r.summary),
    el("p", { class: "mut" }, `Confidence: ${r.confidence}${r.mock ? " · FIXTURE DATA" : ""}`)));
  if (settlement?.transaction) root.append(section("Your payment", el("a", { href: scan(settlement.transaction), target: "_blank", rel: "noopener" }, settlement.transaction)));
  if (r.regions?.length) root.append(section("Regions mentioned", el("ul", {}, ...r.regions.map((x) => el("li", {}, `${x.region}: ${x.posts} post(s), ${Math.round(x.share * 100)}%`)))));
  if (r.focus) root.append(section(`Focus: ${r.focus.requested}`, el("p", {}, `${r.focus.posts} matching post(s), ${Math.round(r.focus.share * 100)}% of the conversation.`)));
  if (r.profile || r.voices?.length || r.audience) {
    const items = [];
    if (r.profile) items.push(el("li", {}, `Project X account: ${r.profile.followers ?? "?"} followers${r.profile.location ? ", " + r.profile.location : ""}`));
    for (const v of r.voices ?? []) items.push(el("li", {}, `@${v.handle}: ${v.followers ?? "?"} followers${v.location ? ", " + v.location : ""}`));
    if (r.audience) items.push(el("li", {}, `Replies read: ${r.audience.comments}, net sentiment ${r.audience.net}`));
    root.append(section("Voices and audience", el("ul", {}, ...items)));
  }
  root.append(section("Growth plan", ...r.recommendations.map((x) => el("div", { class: "rec" }, el("b", {}, `[${x.priority}] ${x.title}`), el("p", {}, x.why), el("p", {}, el("i", {}, x.action))))));
  if (r.topPosts?.length) root.append(section("Top posts", el("ul", {}, ...r.topPosts.map((p) => el("li", {}, `${p.source} · ${p.engagement} engagement · ${p.text}`)))));
  const buys = j.evidence?.supplierPurchases ?? [];
  root.append(section(`Data the agent bought for you (${buys.length} payments via buy)`, el("ul", {}, ...buys.map((b) =>
    el("li", {}, `${b.kind ?? b.source} · $${Number(b.usd).toFixed(3)} · `, b.tx ? el("a", { href: scan(b.tx), target: "_blank", rel: "noopener" }, b.tx.slice(0, 10) + "…") : "no tx")))));
  if (j.evidence?.responseShapes?.length) {
    const d = el("details", { class: "card" }, el("summary", {}, "Technical details: response field names (no content)"),
      el("pre", {}, JSON.stringify(j.evidence.responseShapes, null, 1)));
    root.append(d);
  }
  if (j.warnings?.length) root.append(section("Notes", el("ul", {}, ...j.warnings.map((w) => el("li", {}, w)))));
}

$("connect").addEventListener("click", connect);
$("pay").addEventListener("click", pay);
