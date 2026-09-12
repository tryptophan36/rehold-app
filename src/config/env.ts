import { getAddress, type Address, type Hex } from "viem";

function requiredAddress(name: string): Address {
  const value = import.meta.env[name] as string | undefined;
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return getAddress(value.toLowerCase());
}

export const env = {
  rpcUrl: (import.meta.env.VITE_RPC_URL as string) ?? "https://testnet.hashio.io/api",
  chainId: Number(import.meta.env.VITE_CHAIN_ID ?? 296),
  usdc: requiredAddress("VITE_USDC_ADDRESS"),
  bond: requiredAddress("VITE_BOND_ADDRESS"),
  bondId: (import.meta.env.VITE_BOND_ID as string) ?? "",
  partition: ((import.meta.env.VITE_BOND_PARTITION as Hex | undefined) ??
    "0x0000000000000000000000000000000000000000000000000000000000000001") as Hex,
  oracle: requiredAddress("VITE_BOND_PRICE_ORACLE"),
  vault: requiredAddress("VITE_REPO_VAULT"),
  market: requiredAddress("VITE_SECONDARY_MARKET"),
  engine: requiredAddress("VITE_MARGIN_ENGINE"),
  walletConnectProjectId: (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string) ?? "",
};
