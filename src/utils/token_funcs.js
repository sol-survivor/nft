import {
  PublicKey,
  SystemProgram,
  Transaction,
  Account,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  setAuthority,
  assertOwner,
  closeAccount,
  initializeAccount,
  initializeMint,
  memoInstruction,
  mintTo,
  transfer,
} from './token_instructions';
import {
  ACCOUNT_LAYOUT,
  getOwnedAccountsFilters,
  MINT_LAYOUT,
  parseTokenAccountData,
} from './token_layout';
import bs58 from 'bs58';

import {
  TOKEN_PROGRAM_ID,
  ATACC_PROGRAM_ID,
  WRAPPED_SOL_MINT,
  MEMO_PROGRAM_ID,
} from './program_addresses'

const util = require('util')

export async function findProgramAddress( seeds, programId ) {
  const [ PK, nonce ] = await PublicKey.findProgramAddress( seeds , programId )
  const newSeeds = seeds.concat(Buffer.from([nonce]))
  return { PK, seeds: newSeeds }
}

export async function getOwnedTokenAccounts(connection, publicKey) {
  let filters = getOwnedAccountsFilters(publicKey);
  let resp = await connection._rpcRequest('getProgramAccounts', [
    TOKEN_PROGRAM_ID.toBase58(),
    {
      commitment: connection.commitment,
      filters,
    },
  ]);
  if (resp.error) {
    throw new Error(
      'failed to get token accounts owned by ' +
        publicKey.toBase58() +
        ': ' +
        resp.error.message,
    );
  }
  return resp.result
    .map(({ pubkey, account: { data, executable, owner, lamports } }) => ({
      publicKey: new PublicKey(pubkey),
      accountInfo: {
        data: bs58.decode(data),
        executable,
        owner: new PublicKey(owner),
        lamports,
      },
    }))
    .filter(({ accountInfo }) => {
      // TODO: remove this check once mainnet is updated
      return filters.every((filter) => {
        if (filter.dataSize) {
          return accountInfo.data.length === filter.dataSize;
        } else if (filter.memcmp) {
          let filterBytes = bs58.decode(filter.memcmp.bytes);
          return accountInfo.data
            .slice(
              filter.memcmp.offset,
              filter.memcmp.offset + filterBytes.length,
            )
            .equals(filterBytes);
        }
        return false;
      });
    });
}

export async function createAndInitializeMint({
  wallet,
  connection,
  mint, // Account to hold token information
  amount, // Number of tokens to issue
  decimals,
}) {
  let transaction = new Transaction();

	
  /***************************
   * Create and initialize the mint
   */

  transaction.add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(
        MINT_LAYOUT.span,
      ),
      space: MINT_LAYOUT.span,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  transaction.add(
    initializeMint({
      mint: mint.publicKey,
      decimals,
      mintAuthority: wallet.publicKey,
    }),
  );

  /***********************************
   * create and initialize a token account
   * for the users wallet
   */

  const pa = await findProgramAddress( [ wallet.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer() ], ATACC_PROGRAM_ID);
  const taccPK = pa.PK;
  const taccSeeds = pa.seeds;

  if (amount > 0) {

    const SYSTEM_PROGRAM_ID = SystemProgram.programId;
    transaction.add({
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: taccPK, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
        { pubkey: mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(0), 
      programId: ATACC_PROGRAM_ID,
    })


    /****************************
    * mint 1 token to the tacc
    */
 
    transaction.add(
      mintTo({
        mint: mint.publicKey,
        destination: taccPK,
        amount,
        mintAuthority: wallet.publicKey,
      }),
    );
  }

  /*********************
  * sign and send
  */

  const { blockhash, feeCalculator } = await connection.getRecentBlockhash()
  transaction.recentBlockhash = blockhash
  transaction.feePayer = wallet.publicKey;
  transaction.partialSign(...[mint]);
  let signed = await wallet.signTransaction(transaction);

  let txid =  await connection.sendRawTransaction(signed.serialize(), {
    preflightCommitment: 'single',
  });
  
  console.log("TXID: "+txid);

  return txid;
//  return await connection.sendTransaction(transaction, signers, {
//    preflightCommitment: 'single',
//  });
}

export async function createAndInitializeTokenAccount({
  connection,
  payer,
  mintPublicKey,
  newAccount,
}) {
  let transaction = new Transaction();
  transaction.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: newAccount.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(
        ACCOUNT_LAYOUT.span,
      ),
      space: ACCOUNT_LAYOUT.span,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  transaction.add(
    initializeAccount({
      account: newAccount.publicKey,
      mint: mintPublicKey,
      owner: payer.publicKey,
    }),
  );
  let signers = [payer, newAccount];
  return await connection.sendTransaction(transaction, signers, {
    preflightCommitment: 'single',
  });
}

export async function createAndInitializeTokenAccountWithSeed({
  connection,
  payer,
  mintPK,
  seed,
  newAccountPK,
}) {

  let transaction = new Transaction()

  const newAccountPubkey = await PublicKey.createWithSeed(payer.publicKey, seed, TOKEN_PROGRAM_ID)

  transaction.add( SystemProgram.createAccountWithSeed({
      fromPubkey: payer.publicKey,
      newAccountPubkey: newAccountPK,
      basePubkey: payer.publicKey,        
      seed,                               
      lamports: await connection.getMinimumBalanceForRentExemption(
        ACCOUNT_LAYOUT.span,
      ),
      space: ACCOUNT_LAYOUT.span,
      programId: TOKEN_PROGRAM_ID,
    })
  )

  transaction.add(
    initializeAccount({
      account: newAccountPK,
      mint: mintPK,
      owner: payer.publicKey,
    }),
  );

  const { blockhash, feeCalculator } = await connection.getRecentBlockhash()
  transaction.recentBlockhash = blockhash
  transaction.sign( payer )
  const bytes = transaction.serialize()

  //console.log(util.inspect(transaction, {showHidden: false, depth: null}))

  let tSig
  try {
    tSig = await connection.sendRawTransaction( bytes, { skipPreflight: true } )
  } catch(err) {
    console.log("Send FAILED:",err)
    const content = JSON.stringify( { err: 'Transaction rejected' } )
    return
  }

  return tSig

console.log(transaction)
/*  let signers = [ payer ];
  return await connection.sendTransaction(transaction, signers, {
    preflightCommitment: 'single',
    //skipPreflight: true,
  });
*/
}
/*
export async function createAndInitializeAssociatedTokenAccount({
  connection,
  payer,
  mintPK,
  walletPK,
}) {

  const pa = await findProgramAddress( [ walletPK.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPK.toBuffer() ], ATACC_PROGRAM_ID )

  const taccPK = pa.PK

  const SYSTEM_PROGRAM_ID = SystemProgram.programId

  let transaction = new Transaction();
  transaction.add({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: taccPK, isSigner: false, isWritable: true },
      { pubkey: walletPK, isSigner: false, isWritable: false },
      { pubkey: mintPK, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0), 
    programId: ATACC_PROGRAM_ID,
  })
  let signatures = [ payer ]
  return await connection.sendTransaction(transaction, signatures, {
    preflightCommitment: 'single',
  });
}
*/
export async function mintTokens({
  connection,
  owner,
  destinationPublicKey,
  amount,
  memo,
  mint,
}) {
  const destinationAccountInfo = await connection.getAccountInfo(
    destinationPublicKey,
  )

  if (!destinationAccountInfo) {
    throw new Error('Destination account does not exist')
  }

  const rentExempt = await connection.getMinimumBalanceForRentExemption( ACCOUNT_LAYOUT.span )
  if (destinationAccountInfo.lamports < rentExempt) {
    throw new Error('Destination account is not rent exempt')
  }

  if (!destinationAccountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error('Destination account is not SPL account')
  }

  const destinationParsed = parseTokenAccountData(destinationAccountInfo.data) 

  if (!destinationParsed.mint.equals(mint)) {
    throw new Error('Destination is wrong mint')
  }

  let transaction = new Transaction()
  transaction.add(
    mintTo({
      mint,
      destination: destinationPublicKey,
      amount,
      mintAuthority: owner.publicKey,
    }),
  )
  if (memo) {
    transaction.add(memoInstruction(memo));
  }
  return await connection.sendTransaction(transaction, [ owner ], {
    preflightCommitment: 'single',
  });
}

export async function setMintAuthority({
  connection,
  mint,
  authorityType,       // 0 = mint tokens, 1 = freeze accounts, 2 = account owner, 3 = close account
  currentAuthority,    // must sign, (owner from initialize mint)
  newAuthority,
  payer,               // payer
}) {
  let transaction = new Transaction()
  transaction.add(
    setAuthority({
      mint,
      authorityType,
      currentAuthority: currentAuthority.publicKey,
      newAuthority, 
    }),
  )
  return await connection.sendTransaction(transaction, [ payer, currentAuthority ], {
    preflightCommitment: 'single',
  });
}

export async function transferTokens({
  connection,
  owner,
  sourcePublicKey,
  destinationPublicKey,
  amount,
  memo,
  mint,
}) {
  const destinationAccountInfo = await connection.getAccountInfo(
    destinationPublicKey,
  );
  if (!!destinationAccountInfo && destinationAccountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    return await transferBetweenSplTokenAccounts({
      connection,
      owner,
      sourcePublicKey,
      destinationPublicKey,
      amount,
      memo,
    });
  }

  const rentExempt = await connection.getMinimumBalanceForRentExemption( ACCOUNT_LAYOUT.span )

  if (!destinationAccountInfo || destinationAccountInfo.lamports < rentExempt) {
    throw new Error('Cannot send to address with zero SOL balances');
  }

  const destinationSplTokenAccount = (
    await getOwnedTokenAccounts(connection, destinationPublicKey)
  )
    .map(({ publicKey, accountInfo }) => {
      return { publicKey, parsed: parseTokenAccountData(accountInfo.data) };
    })
    .filter(({ parsed }) => parsed.mint.equals(mint))
    .sort((a, b) => {
      return b.parsed.amount - a.parsed.amount;
    })[0];

  if (destinationSplTokenAccount) {
    return await transferBetweenSplTokenAccounts({
      connection,
      owner,
      sourcePublicKey,
      destinationPublicKey: destinationSplTokenAccount.publicKey,
      amount,
      memo,
    });
  }
  return await createAndTransferToAccount({
    connection,
    owner,
    sourcePublicKey,
    destinationPublicKey,
    amount,
    memo,
    mint,
  });
}

function createTransferBetweenSplTokenAccountsInstruction({
  owner,
  sourcePublicKey,
  destinationPublicKey,
  amount,
  memo,
}) {
  let transaction = new Transaction().add(
    transfer({
      source: sourcePublicKey,
      destination: destinationPublicKey,
      owner: owner.publicKey,
      amount,
    }),
  );
  if (memo) {
    transaction.add(memoInstruction(memo));
  }
  return transaction;
}

async function transferBetweenSplTokenAccounts({
  connection,
  owner,
  sourcePublicKey,
  destinationPublicKey,
  amount,
  memo,
}) {
  const transaction = createTransferBetweenSplTokenAccountsInstruction({
    owner,
    sourcePublicKey,
    destinationPublicKey,
    amount,
    memo,
  });
  let signers = [owner];
  return await connection.sendTransaction(transaction, signers, {
    preflightCommitment: 'single',
  });
}


async function createAndTransferToAccount({
  connection,
  owner,
  sourcePublicKey,
  destinationPublicKey,
  amount,
  memo,
  mint,
}) {
  const newAccount = new Account();
  let transaction = new Transaction();
  transaction.add(
    assertOwner({
      account: destinationPublicKey,
      owner: SystemProgram.programId,
    }),
  );
  transaction.add(
    SystemProgram.createAccount({
      fromPubkey: owner.publicKey,
      newAccountPubkey: newAccount.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(
        ACCOUNT_LAYOUT.span,
      ),
      space: ACCOUNT_LAYOUT.span,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  transaction.add(
    initializeAccount({
      account: newAccount.publicKey,
      mint,
      owner: destinationPublicKey,
    }),
  );
  const transferBetweenAccountsTxn = createTransferBetweenSplTokenAccountsInstruction(
    {
      owner,
      sourcePublicKey,
      destinationPublicKey: newAccount.publicKey,
      amount,
      memo,
    },
  );
  transaction.add(transferBetweenAccountsTxn);
  let signers = [owner, newAccount];
  return await connection.sendTransaction(transaction, signers, {
    preflightCommitment: 'single',
  });
}

export async function closeTokenAccount({
  connection,
  owner,
  sourcePublicKey,
}) {
  let transaction = new Transaction().add(
    closeAccount({
      source: sourcePublicKey,
      destination: owner.publicKey,
      owner: owner.publicKey,
    }),
  );
  let signers = [owner];
  return await connection.sendTransaction(transaction, signers, {
    preflightCommitment: 'single',
  });
}

export function generateSVG(mint="",amount=1){
	let svgText = `<svg height=600 width=800>
	      <defs>
			<linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="0%">
			  <stop offset="0%" style="stop-color:purple;stop-opacity:1" />
			  <stop offset="100%" style="stop-color:blue;stop-opacity:1" />
			</linearGradient>
		  </defs>
       <g>
         <circle 
          id="circle" 
          cx="400" cy="300" 
          r="130" />
         <path id="arc" d="M395 170.1
           A 130 130, 0, 1, 0, 400 170 Z"
           stroke="black" fill="url(#grad1)"/>
         <text id="circleText" width="500" fill="red" font-size="2.2vh">
           <textPath id="circleTextPath" xlink:href="#arc"
            startOffset="0%">
              ${mint} - ${amount.toString()}
             <animate attributeName="startOffset"
               from="0%" to ="50%"
               begin="0s" dur="70s"
               repeatCount="10"/>
               <animate attributeName="startOffset"
               from="0%" to ="50%"
               begin="70s" dur="70s"
               repeatCount="10"/>
            </textPath>
        </g>
      </svg>
	`
	return svgText;
}
