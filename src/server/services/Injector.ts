import Web3 from 'web3';
import path from 'path';
import { Logger } from '../../../services/core/build/index';
import * as bunyan from 'bunyan';
import { Match, InputData, StringMap, cborDecode, NotFoundError, getChainByName } from '../../../services/core/build/index';
import { FileService } from '../services/FileService';
// tslint:disable no-unused-variable
import fs from 'fs'
const solc: any = require('solc');


// tslint:disable no-commented-code
// import { findAddresses } from './address-db';

const multihashes: any = require('multihashes');

import {
  save
} from '../../utils/Utils';

export interface InjectorConfig {
  infuraPID?: string,
  localChainUrl?: string,
  silent?: boolean,
  log?: bunyan,
  offline?: boolean
}

export default class Injector {
  private log: bunyan;
  private chains: any;
  private infuraPID: string;
  private localChainUrl: string | undefined;
  private offline: boolean;
  public fileService: FileService;

  /**
   * Constructor
   * @param {InjectorConfig = {}} config
   */
  public constructor(config: InjectorConfig = {}) {
    this.chains = {};
    this.infuraPID = config.infuraPID || "changeinfuraid";
    this.localChainUrl = config.localChainUrl;
    this.offline = config.offline || false;

    this.log = config.log || Logger("Injector");

    this.fileService = new FileService(this.log);

    if (!this.offline) {
      this.initChains();
    }
  }

  /**
   * Instantiates a web3 provider for all public ethereum networks via Infura.
   * If environment variable TESTING is set to true, localhost:8545 is also available.
   */
  private initChains() {
    for (const chain of ['mainnet', 'ropsten', 'rinkeby', 'kovan', 'goerli']) {
      const chainOption = getChainByName(chain);
      this.chains[chainOption.chainId] = {};
      if (this.infuraPID === "changeinfuraid") {
        const web3 = chainOption.fullnode.dappnode;
        this.chains[chainOption.chainId].web3 = new Web3(web3);
      } else {
        const web3 = chainOption.web3[0].replace('${INFURA_ID}', this.infuraPID);
        this.chains[chainOption.chainId].web3 = new Web3(web3);
      }
    }

    // For unit testing with testrpc...
    if (this.localChainUrl) {
      const chainOption = getChainByName('localhost');
      this.chains[chainOption.chainId] = {
        web3: new Web3(chainOption.web3[0])
      };
    }
  }

  /**
   * Selects metadata files from an array of files that may include sources, etc
   * @param  {string[]} files
   * @return {string[]}         metadata
   */
  private findMetadataFiles(files: string[]): any[] {
    const metadataFiles = [];

    for (const i in files) {
      try {
        const m = JSON.parse(files[i])

        // TODO: this might need a stronger validation check.
        //       many assumptions are made about structure of
        //       metadata object after this selection step.
        if (m['language'] === 'Solidity') {
          metadataFiles.push(m);
        }
      } catch (err) { /* ignore */ }
    }

    if (!metadataFiles.length) {
      const err = new Error("Metadata file not found. Did you include \"metadata.json\"?");
      this.log.info({ loc: '[FIND]', err: err });
      throw err;
    }

    return metadataFiles;
  }

  /**
   * Generates a map of files indexed by the keccak hash of their contents
   * @param  {string[]}  files sources
   * @return {StringMap}
   */
  private storeByHash(files: string[]): StringMap {
    const byHash: StringMap = {};

    for (const i in files) {
      byHash[Web3.utils.keccak256(files[i])] = files[i]
    }
    return byHash;
  }

  /**
   * Validates metadata content keccak hashes for all files and
   * returns mapping of file contents by file name
   * @param  {any}       metadata
   * @param  {string[]}  files    source files
   * @return {StringMap}
   */
  private rearrangeSources(metadata: any, files: string[]): StringMap {
    const sources: StringMap = {}
    const byHash = this.storeByHash(files);

    for (const fileName in metadata.sources) {
      let content: string = metadata.sources[fileName].content;
      const hash: string = metadata.sources[fileName].keccak256;
      if (content) {
        if (Web3.utils.keccak256(content) != hash) {
          const err = new Error(`Invalid content for file ${fileName}`);
          this.log.info({ loc: '[REARRANGE]', fileName: fileName, err: err });
          throw err;
        }
      } else {
        content = byHash[hash];
      }
      if (!content) {
        const err = new Error(
          `The metadata file mentions a source file called "${fileName}" ` +
          `that cannot be found in your upload.\nIts keccak256 hash is ${hash}. ` +
          `Please try to find it and include it in the upload.`
        );
        this.log.info({ loc: '[REARRANGE]', fileName: fileName, err: err });
        throw err;
      }
      sources[fileName] = content;
    }
    return sources
  }

  /**
   * Writes verified sources to repository by address and by ipfs | swarm hash
   * @param {string}              repository        repository root (ex: 'repository')
   * @param {string}              chain             chain name (ex: 'ropsten')
   * @param {string}              address           contract address
   * @param {RecompilationResult} compilationResult solc output
   * @param {StringMap}           sources           'rearranged' sources
   */
  private storePerfectMatchData(
    repository: string,
    chain: string,
    address: string,
    compilationResult: RecompilationResult,
    sources: StringMap
  ): void {

    let metadataPath: string;
    const bytes = Web3.utils.hexToBytes(compilationResult.deployedBytecode);
    const cborData = cborDecode(bytes);

    if (cborData['bzzr0']) {
      metadataPath = `/swarm/bzzr0/${Web3.utils.bytesToHex(cborData['bzzr0']).slice(2)}`;
    } else if (cborData['bzzr1']) {
      metadataPath = `/swarm/bzzr1/${Web3.utils.bytesToHex(cborData['bzzr1']).slice(2)}`;
    } else if (cborData['ipfs']) {
      metadataPath = `/ipfs/${multihashes.toB58String(cborData['ipfs'])}`;
    } else {
      const err = new Error(
        "Re-compilation successful, but could not find reference to metadata file in cbor data."
      );

      this.log.info({
        loc: '[STOREDATA]',
        address: address,
        chain: chain,
        err: err
      });

      throw err;
    }

    const hashPath = path.join(repository, metadataPath);
    const addressPath = path.join(
      repository,
      'contracts',
      'full_match',
      chain,
      address,
      '/metadata.json'
    );

    save(hashPath, compilationResult.metadata);
    save(addressPath, compilationResult.metadata);

    for (const sourcePath in sources) {

      const sanitizedPath = sourcePath
        .replace(/[^a-z0-9_.\/-]/gim, "_")
        .replace(/(^|\/)[.]+($|\/)/, '_');

      const outputPath = path.join(
        repository,
        'contracts',
        'full_match',
        chain,
        address,
        'sources',
        sanitizedPath
      );

      save(outputPath, sources[sourcePath]);
    }
  }

  /**
   * Writes verified sources to repository by address under the "partial_match" folder.
   * This method used when recompilation bytecode matches deployed *except* for their
   * metadata components.
   * @param {string}              repository        repository root (ex: 'repository')
   * @param {string}              chain             chain name (ex: 'ropsten')
   * @param {string}              address           contract address
   * @param {RecompilationResult} compilationResult solc output
   * @param {StringMap}           sources           'rearranged' sources
   */
  private storePartialMatchData(
    repository: string,
    chain: string,
    address: string,
    compilationResult: RecompilationResult,
    sources: StringMap
  ): void {

    const addressPath = path.join(
      repository,
      'contracts',
      'partial_match',
      chain,
      address,
      '/metadata.json'
    );

    save(addressPath, compilationResult.metadata);

    for (const sourcePath in sources) {

      const sanitizedPath = sourcePath
        .replace(/[^a-z0-9_.\/-]/gim, "_")
        .replace(/(^|\/)[.]+($|\/)/, '_');

      const outputPath = path.join(
        repository,
        'contracts',
        'partial_match',
        chain,
        address,
        'sources',
        sanitizedPath
      );

      save(outputPath, sources[sourcePath]);
    }
  }

  /**
   * Searches a set of addresses for the one whose deployedBytecode
   * matches a given bytecode string
   * @param {String[]}          addresses
   * @param {string}      deployedBytecode
   */
  private async matchBytecodeToAddress(
    chain: string,
    addresses: string[] = [],
    compiledBytecode: string
  ): Promise<Match> {
    let match: Match = { address: null, status: null };

    for (let address of addresses) {
      address = Web3.utils.toChecksumAddress(address)

      let deployedBytecode: string | null = null;
      try {
        this.log.info(
          {
            loc: '[MATCH]',
            chain: chain,
            address: address
          },
          `Retrieving contract bytecode address`
        );
        deployedBytecode = await getBytecode(this.chains[chain].web3, address)
      } catch (e) { /* ignore */ }

      const status = this.compareBytecodes(deployedBytecode, compiledBytecode);

      if (status) {
        match = { address: address, status: status };
        break;
      }
    }
    return match;
  }

  /**
   * Returns a string description of how closely two bytecodes match. Bytecodes
   * that match in all respects apart from their metadata hashes are 'partial'.
   * Bytecodes that don't match are `null`.
   * @param  {string} deployedBytecode
   * @param  {string} compiledBytecode
   * @return {string | null}  match description ('perfect'|'partial'|null)
   */
  private compareBytecodes(
    deployedBytecode: string | null,
    compiledBytecode: string
  ): 'perfect' | 'partial' | null {

    if (deployedBytecode && deployedBytecode.length > 2) {
      if (deployedBytecode === compiledBytecode) {
        return 'perfect';
      }

      if (trimMetadata(deployedBytecode) === trimMetadata(compiledBytecode)) {
        return 'partial';
      }
    }
    return null;
  }

  /**
   * Throws if addresses array contains a null value (express) or is length 0
   * @param {string[] = []} addresses param (submitted to injector)
   */
  private validateAddresses(addresses: string[] = []) {
    const err = new Error("Missing address for submitted sources/metadata");

    if (!addresses.length) {
      throw err;
    }

    for (const address of addresses) {
      if (address == null) throw err;
    }
  }

  /**
   * Throws if `chain` is falsy or wrong type
   * @param {string} chain param (submitted to injector)
   */
  private validateChain(chain: string) {

    if (!chain || typeof chain !== 'string') {
      throw new Error("Missing chain name for submitted sources/metadata");;
    }

  }

  /**
   * Used by the front-end. Accepts a set of source files and a metadata string,
   * recompiles / validates them and stores them in the repository by chain/address
   * and by swarm | ipfs hash.
   * @param  {string}            repository repository root (ex: 'repository')
   * @param  {string}            chain      chain name (ex: 'ropsten')
   * @param  {string}            address    contract address
   * @param  {string[]}          files
   * @return {Promise<object>}              address & status of successfully verified contract
   */
  public async inject(
    inputData: InputData
  ): Promise<Match> {
    const { repository, chain, addresses, files } = inputData;
    this.validateAddresses(addresses);
    this.validateChain(chain);

    let match: Match = {
      address: null,
      status: null
    };

    for (const source of files) {

      // Starting from here, we cannot trust the metadata object anymore,
      // because it is modified inside recompile.
      const target = Object.assign({}, source.metadata.settings.compilationTarget);

      let compilationResult: RecompilationResult;
      try {
        compilationResult = await recompile(source.metadata, source.solidity, this.log)
      } catch (err) {
        this.log.info({ loc: `[RECOMPILE]`, err: err });
        throw err;
      }

      // When injector is called by monitor, the bytecode has already been
      // obtained for address and we only need to compare w/ compilation result.
      if (inputData.bytecode) {

        const status = this.compareBytecodes(
          inputData.bytecode,
          compilationResult.deployedBytecode
        )

        match = {
          address: Web3.utils.toChecksumAddress(addresses[0]),
          status: status
        }

        // For other cases, we need to retrieve the code for specified address
        // from the chain.
      } else {
        match = await this.matchBytecodeToAddress(
          chain,
          addresses,
          compilationResult.deployedBytecode
        )
      }

      // Since the bytecode matches, we can be sure that we got the right
      // metadata file (up to json formatting) and exactly the right sources.
      // Now we can store the re-compiled and correctly formatted metadata file
      // and the sources.
      if (match.address && match.status === 'perfect') {

        this.storePerfectMatchData(repository, chain, match.address, compilationResult, source.solidity)

      } else if (match.address && match.status === 'partial') {

        this.storePartialMatchData(repository, chain, match.address, compilationResult, source.solidity)

      } else {
        const err = new Error(
          `Could not match on-chain deployed bytecode to recompiled bytecode for:\n` +
          `${JSON.stringify(target, null, ' ')}\n` +
          `Addresses checked:\n` +
          `${JSON.stringify(addresses, null, ' ')}`
        );

        this.log.info({
          loc: '[INJECT]',
          chain: chain,
          addresses: addresses,
          err: err
        })

        throw new NotFoundError(err.message);
      }
    }
    return match;
  }
}

export interface RecompilationResult {
  bytecode: string,
  deployedBytecode: string,
  metadata: string
}

/**
 * Wraps eth_getCode
 * @param {Web3}   web3    connected web3 instance
 * @param {string} address contract
 */
export async function getBytecode(web3: Web3, address: string) {
  address = web3.utils.toChecksumAddress(address);
  return await web3.eth.getCode(address);
};

/**
 * Compiles sources using version and settings specified in metadata
 * @param  {any}                          metadata
 * @param  {string[]}                     sources  solidity files
 * @return {Promise<RecompilationResult>}
 */
export async function recompile(
  metadata: any,
  sources: StringMap,
  log: any
): Promise<RecompilationResult> {

  const {
    input,
    fileName,
    contractName
  } = reformatMetadata(metadata, sources, log);

  const version = metadata.compiler.version;

  log.info(
    {
      loc: '[RECOMPILE]',
      fileName: fileName,
      contractName: contractName,
      version: version
    },
    'Recompiling'
  );

  const solcjs: any = await new Promise((resolve, reject) => {
    solc.loadRemoteVersion(`v${version}`, (error: Error, soljson: any) => {
      (error) ? reject(error) : resolve(soljson);
    });
  });

  const compiled: any = solcjs.compile(JSON.stringify(input));
  const output = JSON.parse(compiled);
  const contract: any = output.contracts[fileName][contractName];

  return {
    bytecode: contract.evm.bytecode.object,
    deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    metadata: contract.metadata.trim()
  }
}

/**
 * Removes post-fixed metadata from a bytecode string
 * (for partial bytecode match comparisons )
 * @param  {string} bytecode
 * @return {string}          bytecode minus metadata
 */
export function trimMetadata(bytecode: string): string {
  // Last 4 chars of bytecode specify byte size of metadata component,
  const metadataSize = parseInt(bytecode.slice(-4), 16) * 2 + 4;
  return bytecode.slice(0, bytecode.length - metadataSize);
}

/**
 * Formats metadata into an object which can be passed to solc for recompilation
 * @param  {any}                 metadata solc metadata object
 * @param  {string[]}            sources  solidity sources
 * @return {ReformattedMetadata}
 */
function reformatMetadata(
  metadata: any,
  sources: StringMap,
  log: any
): ReformattedMetadata {

  const input: any = {};
  let fileName: string = '';
  let contractName: string = '';

  input.settings = metadata.settings;

  for (fileName in metadata.settings.compilationTarget) {
    contractName = metadata.settings.compilationTarget[fileName];
  }

  delete input['settings']['compilationTarget']

  if (contractName == '') {
    const err = new Error("Could not determine compilation target from metadata.");
    log.info({ loc: '[REFORMAT]', err: err });
    throw err;
  }

  input['sources'] = {}
  for (const source in sources) {
    input.sources[source] = { 'content': sources[source] }
  }

  input.language = metadata.language
  input.settings.metadata = input.settings.metadata || {}
  input.settings.outputSelection = input.settings.outputSelection || {}
  input.settings.outputSelection[fileName] = input.settings.outputSelection[fileName] || {}

  input.settings.outputSelection[fileName][contractName] = [
    'evm.bytecode',
    'evm.deployedBytecode',
    'metadata'
  ];

  return {
    input: input,
    fileName: fileName,
    contractName: contractName
  }
}

export declare interface ReformattedMetadata {
  input: any,
  fileName: string,
  contractName: string
}