import { createConfig, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { hederaTestnet } from "./chain";
import { env } from "./env";

const connectors = [
  injected({ shimDisconnect: true }),
  ...(env.walletConnectProjectId
    ? [
        walletConnect({
          projectId: env.walletConnectProjectId,
          metadata: {
            name: "ReHold Desk",
            description: "Treasury repo desk on Hedera testnet",
            url: "http://localhost:5173",
            icons: [],
          },
        }),
      ]
    : []),
];

export const wagmiConfig = createConfig({
  chains: [hederaTestnet],
  connectors,
  transports: {
    [hederaTestnet.id]: http(env.rpcUrl),
  },
});
