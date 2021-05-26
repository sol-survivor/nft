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

export function generateSVG(mint="",amount=1,decimals=0){
	let mintFontSize ="1.08vw";
	let svgText =`
		<svg width="290" height="500" viewBox="0 0 290 500" xmlns="http://www.w3.org/2000/svg" xmlns:xlink='http://www.w3.org/1999/xlink'>
		<defs><filter id="f1">
		<feImage result="p0" xlink:href="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0nMjkwJyBoZWlnaHQ9JzUwMCcgdmlld0JveD0nMCAwIDI5MCA1MDAnIHhtbG5zPSdodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Zyc+PHJlY3Qgd2lkdGg9JzI5MHB4JyBoZWlnaHQ9JzUwMHB4JyBmaWxsPSdwdXJwbGUnLz48L3N2Zz4="/><feImage result="p1" xlink:href="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0nMjkwJyBoZWlnaHQ9JzUwMCcgdmlld0JveD0nMCAwIDI5MCA1MDAnIHhtbG5zPSdodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Zyc+PGNpcmNsZSBjeD0nMTkyJyBjeT0nMzI1JyByPScxMjBweCcgZmlsbD0nZGFya3JlZCcvPjwvc3ZnPg=="/><feImage result="p2" xlink:href="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0nMjkwJyBoZWlnaHQ9JzUwMCcgdmlld0JveD0nMCAwIDI5MCA1MDAnIHhtbG5zPSdodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Zyc+PGNpcmNsZSBjeD0nMjQzJyBjeT0nMzYyJyByPScxMjBweCcgZmlsbD0ncHVycGxlJy8+PC9zdmc+" /><feImage result="p3" xlink:href="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0nMjkwJyBoZWlnaHQ9JzUwMCcgdmlld0JveD0nMCAwIDI5MCA1MDAnIHhtbG5zPSdodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Zyc+PGNpcmNsZSBjeD0nMzcnIGN5PScxMzEnIHI9JzEwMHB4JyBmaWxsPSdyZWQnLz48L3N2Zz4=" /><feBlend mode="overlay" in="p0" in2="p1" /><feBlend mode="exclusion" in2="p2" /><feBlend mode="overlay" in2="p3" result="blendOut" /><feGaussianBlur in="blendOut" stdDeviation="42" /></filter> <clipPath id="corners"><rect width="290" height="500" rx="42" ry="42" /></clipPath><path id="text-path-a" d="M40 12 H250 A28 28 0 0 1 278 40 V460 A28 28 0 0 1 250 488 H40 A28 28 0 0 1 12 460 V40 A28 28 0 0 1 40 12 z" />
		<path id="minimap" d="M234 444C234 457.949 242.21 463 253 463" />
		<filter id="top-region-blur"><feGaussianBlur in="SourceGraphic" stdDeviation="24" /></filter>
		<linearGradient id="grad-up" x1="1" x2="0" y1="1" y2="0">
		<stop offset="0.0" stop-color="white" stop-opacity="1" /><stop offset=".9" stop-color="white" stop-opacity="0" /></linearGradient>
		<linearGradient id="grad-down" x1="0" x2="1" y1="0" y2="1">
		<stop offset="0.0" stop-color="white" stop-opacity="1" />
		<stop offset="0.9" stop-color="white" stop-opacity="0" /></linearGradient>
		<mask id="fade-up" maskContentUnits="objectBoundingBox">
		<rect width="1" height="1" fill="url(#grad-up)" /></mask>
		<mask id="fade-down" maskContentUnits="objectBoundingBox">
		<rect width="1" height="1" fill="url(#grad-down)" /></mask>
		<mask id="none" maskContentUnits="objectBoundingBox">
		<rect width="1" height="1" fill="white" /></mask>
		<linearGradient id="grad-symbol">
		<stop offset="0.7" stop-color="white" stop-opacity="1" />
		<stop offset=".95" stop-color="white" stop-opacity="0" /></linearGradient>
		<mask id="fade-symbol" maskContentUnits="userSpaceOnUse">
		<rect width="290px" height="200px" fill="url(#grad-symbol)" /></mask></defs>
		<g clip-path="url(#corners)">
		<rect fill="purple" x="0px" y="0px" width="290px" height="500px" />
		<rect style="filter: url(#f1)" x="0px" y="0px" width="290px" height="500px" /> 
		<g style="filter:url(#top-region-blur); transform:scale(1.5); transform-origin:center top;">
		<rect fill="none" x="0px" y="0px" width="290px" height="500px" />
		<ellipse cx="50%" cy="0px" rx="180px" ry="120px" fill="#000" opacity="0.85" />
		</g>
		<rect x="0" y="0" width="290" height="500" rx="42" ry="42" fill="transparent" stroke="rgba(255,255,255,0.2)" />
		</g>
		<text text-rendering="optimizeSpeed">
		<textPath startOffset="-100%" fill="white" font-family="'Courier New', monospace" font-size="${mintFontSize}" xlink:href="#text-path-a">
		${mint}
		 ◎ 
		 <animate additive="sum" attributeName="startOffset" from="0%" to="100%" begin="0s" dur="30s" repeatCount="indefinite" />
		</textPath> <textPath startOffset="0%" fill="white" font-family="'Courier New', monospace" font-size="${mintFontSize}" xlink:href="#text-path-a">
		${mint}
		 ◎ 
		 <animate additive="sum" attributeName="startOffset" from="0%" to="100%" begin="0s" dur="30s" repeatCount="indefinite" /> </textPath>
		<textPath startOffset="50%" fill="white" font-family="'Courier New', monospace" font-size="${mintFontSize}" xlink:href="#text-path-a">
		${mint}
		 ◎ 
		 <animate additive="sum" attributeName="startOffset" from="0%" to="100%" begin="0s" dur="30s"
		 repeatCount="indefinite" /></textPath><textPath startOffset="-50%" fill="white" font-family="'Courier New', monospace" font-size="${mintFontSize}" xlink:href="#text-path-a">
		${mint}
		 ◎ 
		 <animate additive="sum" attributeName="startOffset" from="0%" to="100%" begin="0s" dur="30s" repeatCount="indefinite" />
		 </textPath>
		 </text>
		 <g style="transform:translate(29px, 414px)">
			 <rect width="105px" height="26px" rx="8px" ry="8px" fill="rgba(0,0,0,0.6)" />
			 <text x="12px" y="17px" font-family="'Courier New', monospace" font-size="12px" fill="white">
			 <tspan fill="rgba(255,255,255,0.6)">Amount: </tspan> ${amount} </text></g> 
		 <g style="transform:translate(29px, 444px)">
			 <rect width="112px" height="26px" rx="8px" ry="8px" fill="rgba(0,0,0,0.6)" />
			 <text x="12px" y="17px" font-family="'Courier New', monospace" font-size="12px" fill="white">
			 <tspan fill="rgba(255,255,255,0.6)">Decimals: </tspan>${decimals}</text>
		 </g>
		</svg>
		`
	return svgText;
}
