function required(name: string): `0x${string}` {
  const value = import.meta.env[name] as string | undefined;
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value as `0x${string}`;
}

export const env = {
  rpcUrl: (import.meta.env.VITE_RPC_URL as string) ?? "https://testnet.hashio.io/api",
  chainId: Number(import.meta.env.VITE_CHAIN_ID ?? 296),
  usdc: required("VITE_USDC_ADDRESS"),
  bond: required("VITE_BOND_ADDRESS"),
  bondId: (import.meta.env.VITE_BOND_ID as string) ?? "",
  partition: (import.meta.env.VITE_BOND_PARTITION as `0x${string}`) ??
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  oracle: required("VITE_BOND_PRICE_ORACLE"),
  vault: required("VITE_REPO_VAULT"),
  market: required("VITE_SECONDARY_MARKET"),
  engine: required("VITE_MARGIN_ENGINE"),
  walletConnectProjectId: (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string) ?? "",
};
