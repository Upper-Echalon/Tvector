import { FullChannelState, FullTransferState, HashlockTransferStateEncoding } from "@connext/vector-types";
import {
  ChannelSigner,
  hashChannelCommitment,
  createlockHash,
  createTestChannelStateWithSigners,
  createTestFullHashlockTransferState,
  expect,
  getRandomAddress,
  getRandomBytes32,
  hashCoreTransferState,
  hashTransferState,
  MemoryStoreService,
} from "@connext/vector-utils";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { keccak256 } from "@ethersproject/keccak256";
import { parseEther } from "@ethersproject/units";
import { MerkleTree } from "merkletreejs";

import { deployContracts } from "../actions";
import { AddressBook } from "../addressBook";
import { logger } from "../constants";
import {
  alice,
  bob,
  chainIdReq,
  getTestAddressBook,
  getTestChannel,
  mineBlock,
  provider,
  rando,
} from "../tests";

import { EthereumChainService } from "./ethService";

describe("EthereumChainService", function() {
  this.timeout(120_000);
  const aliceSigner = new ChannelSigner(alice.privateKey);
  const bobSigner = new ChannelSigner(bob.privateKey);
  let addressBook: AddressBook;
  let channel: Contract;
  let channelFactory: Contract;
  let transferDefinition: Contract;
  let chainService: EthereumChainService;
  let channelState: FullChannelState<any>;
  let transferState: FullTransferState;
  let token: Contract;
  let chainId: number;

  beforeEach(async () => {
    addressBook = await getTestAddressBook();
    chainId = await chainIdReq;
    await deployContracts(alice, addressBook, [
      ["TestToken", []],
      ["HashlockTransfer", []],
    ]);
    channel = await getTestChannel(addressBook);
    channelFactory = addressBook.getContract("ChannelFactory");
    chainService = new EthereumChainService(
      new MemoryStoreService(),
      { [chainId]: provider },
      alice.privateKey,
      logger,
    );
    token = addressBook.getContract("TestToken");
    transferDefinition = addressBook.getContract("HashlockTransfer");
    await (await token.mint(alice.address, parseEther("1"))).wait();
    await (await token.mint(bob.address, parseEther("1"))).wait();
    const preImage = getRandomBytes32();
    const state = {
      lockHash: createlockHash(preImage),
      expiry: "0",
    };
    transferState = createTestFullHashlockTransferState({
      chainId,
      initiator: alice.address,
      responder: bob.address,
      transferDefinition: transferDefinition.address,
      assetId: AddressZero,
      channelAddress: channel.address,
      // use random receiver addr to verify transfer when bob must dispute
      balance: { to: [alice.address, getRandomAddress()], amount: ["7", "0"] },
      transferState: state,
      transferResolver: { preImage },
      transferTimeout: "2",
      initialStateHash: hashTransferState(state, HashlockTransferStateEncoding),
    });

    channelState = createTestChannelStateWithSigners([aliceSigner, bobSigner], "create", {
      channelAddress: channel.address,
      assetIds: [AddressZero],
      balances: [{ to: [alice.address, bob.address], amount: ["17", "45"] }],
      processedDepositsA: ["0"],
      processedDepositsB: ["62"],
      timeout: "2",
      nonce: 3,
      merkleRoot: new MerkleTree([hashCoreTransferState(transferState)], keccak256).getHexRoot(),
    });
    const channelHash = hashChannelCommitment(channelState);
    channelState.latestUpdate.aliceSignature = await aliceSigner.signMessage(channelHash);
    channelState.latestUpdate.bobSignature = await bobSigner.signMessage(channelHash);

  });

  it("should be created without error", async () => {
    expect(channel.address).to.be.ok;
    expect(chainService).to.be.ok;
  });

  it("should run sendDepositTx without error", async () => {
    const res = await chainService.sendDepositTx(
      channelState,
      alice.address,
      "10",
      AddressZero,
    );
    expect(res.getValue()).to.be.ok;
  });

  it("should run sendWithdrawTx without error", async () => {
    const res = await chainService.sendWithdrawTx(
      channelState,
      {
        to: bob.address,
        data: "0x",
        value: "0x01",
      },
    );
    expect(res.getValue()).to.be.ok;
  });

  // Need to setup a channel between alice & rando else it'll error w "channel already deployed"
  it("should run sendDeployChannelTx without error", async () => {
    const channelAddress = (await chainService.getChannelAddress(
      alice.address,
      rando.address,
      channelFactory.address,
      chainId,
    )).getValue();
    const newChannelState = {
      ...channelState,
      bob: rando.address,
      channelAddress,
    };
    const res = await chainService.sendDeployChannelTx(
      newChannelState,
      {
        amount: "0x01",
        assetId: AddressZero,
      },
    );
    expect(res.getValue()).to.be.ok;
  });

  it("should run sendDisputeChannelTx without error", async () => {
    const res = await chainService.sendDisputeChannelTx(channelState);
    expect(res.getValue()).to.be.ok;
  });

  it("should run sendDefundChannelTx without error", async () => {
    await chainService.sendDisputeChannelTx(channelState);
    await mineBlock();
    const res = await chainService.sendDefundChannelTx(channelState);
    expect(res.getValue()).to.be.ok;
  });

  it("should run sendDisputeTransferTx without error", async () => {
    await chainService.sendDisputeChannelTx(channelState);
    await mineBlock();
    await mineBlock();
    const res = await chainService.sendDisputeTransferTx(transferState.transferId, [transferState]);
    expect(res.getValue()).to.be.ok;
  });

  // Fails with INVALID_MSG_SENDER
  it("should run sendDefundTransferTx without error", async () => {
    await chainService.sendDisputeChannelTx(channelState);
    await mineBlock();
    await mineBlock();
    await chainService.sendDisputeTransferTx(transferState.transferId, [transferState]);
    // Bob is the one who will defund, create a chainService for him to do so
    const bobChainService = new EthereumChainService(
      new MemoryStoreService(),
      { [chainId]: provider },
      bob.privateKey,
      logger,
    );
    const res = await bobChainService.sendDefundTransferTx(transferState);
    expect(res.getValue()).to.be.ok;
  });

});
