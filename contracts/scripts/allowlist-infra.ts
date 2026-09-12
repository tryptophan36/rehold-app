import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

const BOND = "0xc746a5530fb1e0dc818cabdce6ae88c1316d87bf";
const GAS = 2_000_000n;

const bondAbi = [
  "function addToControlList(address account) returns (bool)",
  "function isInControlList(address account) view returns (bool)",
];

async function main() {
  const deployments = JSON.parse(readFileSync(join(__dirname, "..", "..", "deployments.testnet.json"), "utf8"));
  const vault = deployments.contracts.RepoVault as string;
  const market = deployments.contracts.SecondaryMarket as string;
  const [signer] = await ethers.getSigners();
  const bond = new ethers.Contract(BOND, bondAbi, signer);

  for (const [label, address] of [
    ["vault", vault],
    ["market", market],
  ] as const) {
    const listed = await bond.isInControlList(address);
    if (listed) {
      console.log(label, address, "already listed");
      continue;
    }
    const tx = await bond.addToControlList(address, { gasLimit: GAS });
    console.log(label, "allowlisting", tx.hash);
    await tx.wait();
    console.log(label, "listed", await bond.isInControlList(address));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
