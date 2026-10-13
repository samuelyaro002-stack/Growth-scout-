import { celo } from "viem/chains";

export { celo };
export const CELO_CHAIN_ID = 42220;
export const CELO_CAIP2 = "eip155:42220" as const;

// ERC-8004 registries on Celo mainnet (docs.celo.org/build/agents/8004)
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const;

// Stablecoins on Celo mainnet. All 6 decimals.
export const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const;
export const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as const;
export const USAT = "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771" as const;

// feeCurrency takes the ADAPTER address for 6-decimal tokens, not the token address.
export const FEE_ADAPTER_USDC = "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B" as const;
export const FEE_ADAPTER_USAT = "0x0357EE22278c922e1D36cFe6b899269b161880C4" as const;

export const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
