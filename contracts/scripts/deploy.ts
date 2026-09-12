import { ethers } from "hardhat";
import { writeFileSync } from "fs";
import { join } from "path";

const USDC = "0x0000000000000000000000000000000000068cDa";
const BOND = "0xc746a5530fb1e0dc818cabdce6ae88c1316d87bf";
const EXISTING_ORACLE = "0x39a337f7860989148825951FF0Ba1415ca98bA3D";

async function main() {
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("No deployer account. Set OPERATOR_PRIVATE_KEY in contracts/.env");
  }
  const [deployer] = signers;
  const deployerAddress = await deployer.getAddress();
  console.log("deployer", deployerAddress);
  console.log("balance", ethers.formatEther(await ethers.provider.getBalance(deployerAddress)), "HBAR");

  const RepoVault = await ethers.getContractFactory("RepoVault");
  const vault = await RepoVault.deploy(USDC, { gasLimit: 8_000_000 });
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("RepoVault", vaultAddress);

  const SecondaryMarket = await ethers.getContractFactory("SecondaryMarket");
  const market = await SecondaryMarket.deploy(USDC, { gasLimit: 8_000_000 });
  await market.waitForDeployment();
  const marketAddress = await market.getAddress();
  console.log("SecondaryMarket", marketAddress);

  const MarginEngine = await ethers.getContractFactory("MarginEngine");
  const engine = await MarginEngine.deploy(vaultAddress, { gasLimit: 4_000_000 });
  await engine.waitForDeployment();
  const engineAddress = await engine.getAddress();
  console.log("MarginEngine", engineAddress);

  const setEngine = await vault.setMarginEngine(engineAddress, { gasLimit: 300_000 });
  await setEngine.wait();
  console.log("linked marginEngine");

  const setMarket = await vault.setSecondaryMarket(marketAddress, { gasLimit: 300_000 });
  await setMarket.wait();
  console.log("linked secondaryMarket");

  const setVault = await market.setRepoVault(vaultAddress, { gasLimit: 300_000 });
  await setVault.wait();
  console.log("linked repoVault on market");

  const setOracle = await vault.setOracleForBond(BOND, EXISTING_ORACLE, { gasLimit: 300_000 });
  await setOracle.wait();
  console.log("registered oracle for HTN-2027-A");

  const registered = await vault.bondOracles(BOND);
  if (registered.toLowerCase() !== EXISTING_ORACLE.toLowerCase()) {
    throw new Error(`oracle mismatch: ${registered}`);
  }

  const record = {
    network: "hedera-testnet",
    chainId: 296,
    deployer: deployerAddress,
    usdc: { hts: "0.0.429274", evm: USDC },
    bond: {
      hts: "0.0.10483609",
      evm: BOND,
      symbol: "HTN-2027-A",
      oracle: EXISTING_ORACLE,
    },
    contracts: {
      BondPriceOracle: EXISTING_ORACLE,
      RepoVault: vaultAddress,
      SecondaryMarket: marketAddress,
      MarginEngine: engineAddress,
    },
  };

  const outPath = join(__dirname, "..", "..", "deployments.testnet.json");
  writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
  console.log("wrote", outPath);
  console.log(JSON.stringify(record, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
