import type { Config } from "./config.js";
import { IDENTITY_REGISTRY } from "./chain.js";

/**
 * ERC-8004 registration file. Served live at /.well-known/agent.json so that the `registrations`
 * block appears as soon as AGENT_ID is set, with no need to re-point the on-chain URI.
 */
export function buildRegistrationFile(cfg: Config) {
  const file: Record<string, unknown> = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "GrowthScout",
    description:
      "Growth-intelligence agent for Web3 projects. Buys live X, Reddit and YouTube data through buy and sells Africa-focused growth reports per request over x402, paid in stablecoins on Celo.",
    services: [
      { name: "web", endpoint: cfg.publicUrl },
      { name: "x402-api", endpoint: `${cfg.publicUrl}/api` },
    ],
    x402Support: true,
    active: true,
    supportedTrust: ["reputation"],
  };
  if (cfg.agentId) {
    file.registrations = [
      { agentId: Number(cfg.agentId), agentRegistry: `eip155:42220:${IDENTITY_REGISTRY}` },
    ];
  }
  return file;
}
