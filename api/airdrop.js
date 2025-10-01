import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountInstruction } from '@solana/spl-token';

let bs58;
try {
  bs58 = (await import('bs58')).default;
} catch (error) {
  console.error('Failed to import bs58:', error);
}

// 在 Vercel 无服务器环境中，我们无法使用文件系统
// 使用内存存储，但注意这会在函数冷启动时重置
const claimedAddresses = new Set();

export default async function handler(req, res) {
  console.log('🔔 Airdrop API called');
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    console.log('❌ Method not allowed:', req.method);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { walletAddress } = req.body;
    console.log('📨 Request body:', req.body);

    if (!walletAddress) {
      console.log('❌ Missing wallet address');
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    // 在 Vercel 中，内存存储会在冷启动时重置
    // 所以我们主要依赖区块链状态检查
    if (claimedAddresses.has(walletAddress)) {
      console.log('❌ Wallet already claimed airdrop (in memory):', walletAddress);
      return res.status(400).json({ error: 'already_claimed' });
    }

    let recipientPublicKey;
    try {
      recipientPublicKey = new PublicKey(walletAddress);
      console.log('✅ Valid wallet address:', walletAddress);
    } catch (error) {
      console.log('❌ Invalid wallet address:', walletAddress);
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }

    // 从环境变量获取配置 - 这些将在 Vercel 中设置
    const senderPrivateKey = process.env.SENDER_PRIVATE_KEY;
    const tokenMintAddress = process.env.TOKEN_MINT_ADDRESS;
    const rpcUrl = process.env.RPC_URL;
    const tokenAmount = parseInt(process.env.TOKEN_AMOUNT || '25000');

    console.log('🔧 Environment check:', {
      hasPrivateKey: !!senderPrivateKey,
      hasTokenMint: !!tokenMintAddress,
      hasRpcUrl: !!rpcUrl,
      tokenAmount
    });

    // 检查环境变量
    if (!senderPrivateKey) {
      console.log('❌ Missing SENDER_PRIVATE_KEY');
      return res.status(500).json({ error: 'Missing SENDER_PRIVATE_KEY environment variable' });
    }
    if (!tokenMintAddress) {
      console.log('❌ Missing TOKEN_MINT_ADDRESS');
      return res.status(500).json({ error: 'Missing TOKEN_MINT_ADDRESS environment variable' });
    }
    if (!rpcUrl) {
      console.log('❌ Missing RPC_URL');
      return res.status(500).json({ error: 'Missing RPC_URL environment variable' });
    }

    console.log('🌐 Starting Solana transaction...');

    // 解析发送者私钥
    let senderKeypair;
    try {
      let privateKeyArray;
      if (senderPrivateKey.startsWith('[')) {
        // JSON数组格式
        privateKeyArray = JSON.parse(senderPrivateKey);
      } else {
        // Base58格式
        if (!bs58) {
          throw new Error('bs58 module not available');
        }
        privateKeyArray = Array.from(bs58.decode(senderPrivateKey));
      }
      senderKeypair = Keypair.fromSecretKey(new Uint8Array(privateKeyArray));
      console.log('✅ Sender keypair created:', senderKeypair.publicKey.toString());
    } catch (error) {
      console.error('❌ Error parsing private key:', error);
      return res.status(500).json({ error: 'Invalid sender private key format: ' + error.message });
    }

    // 创建连接
    const connection = new Connection(rpcUrl, 'confirmed');
    console.log('✅ Connected to RPC:', rpcUrl);

    // 创建代币mint的公钥
    const mintPublicKey = new PublicKey(tokenMintAddress);
    console.log('✅ Token mint:', mintPublicKey.toString());

    // ==================== 区块链状态检查 ====================
    console.log('🔍 Checking blockchain state for recipient...');
    
    // 检查钱包是否已经有代币余额
    try {
      const recipientTokenAccount = await getAssociatedTokenAddress(
        mintPublicKey,
        recipientPublicKey
      );
      
      // 检查代币账户是否存在且有余额
      try {
        const recipientBalance = await connection.getTokenAccountBalance(recipientTokenAccount);
        console.log('💰 Recipient current balance:', recipientBalance.value.uiAmount);
        
        // 如果钱包已经有代币余额，认为已经领取过
        if (recipientBalance.value.uiAmount > 0) {
          console.log('❌ Wallet already has DUCK tokens:', walletAddress);
          return res.status(400).json({ error: 'already_has_tokens' });
        }
      } catch (error) {
        // 如果代币账户不存在，说明没有领取过，这是正常情况
        console.log('ℹ️ Recipient has no token account yet, proceeding with airdrop');
      }
    } catch (error) {
      console.error('❌ Error checking recipient balance:', error);
      // 不阻止空投，只是记录错误
    }
    // ==================== 区块链状态检查结束 ====================

    // 获取发送者的代币账户地址
    const senderTokenAccount = await getAssociatedTokenAddress(
      mintPublicKey,
      senderKeypair.publicKey
    );
    console.log('✅ Sender token account:', senderTokenAccount.toString());

    // 获取接收者的代币账户地址
    const recipientTokenAccount = await getAssociatedTokenAddress(
      mintPublicKey,
      recipientPublicKey
    );
    console.log('✅ Recipient token account:', recipientTokenAccount.toString());

    // 检查发送者余额
    let senderBalance;
    try {
      senderBalance = await connection.getTokenAccountBalance(senderTokenAccount);
      console.log('✅ Sender balance:', senderBalance.value.uiAmount);
      
      if (senderBalance.value.uiAmount < tokenAmount) {
        return res.status(400).json({ error: 'insufficient_token_balance' });
      }
    } catch (error) {
      console.error('❌ Error checking sender balance:', error);
      return res.status(500).json({ error: 'Cannot check sender token balance: ' + error.message });
    }

    // 检查接收者是否已经有代币账户
    let recipientTokenAccountInfo;
    try {
      recipientTokenAccountInfo = await connection.getAccountInfo(recipientTokenAccount);
      console.log('✅ Recipient token account exists:', !!recipientTokenAccountInfo);
    } catch (error) {
      console.log('ℹ️ Recipient token account does not exist, will create it');
    }

    const transaction = new Transaction();

    // 如果接收者没有代币账户，需要先创建
    if (!recipientTokenAccountInfo) {
      console.log('🆕 Creating associated token account for recipient');
      const createATAInstruction = createAssociatedTokenAccountInstruction(
        senderKeypair.publicKey, // 支付账户
        recipientTokenAccount,   // 关联代币账户地址
        recipientPublicKey,      // 代币所有者
        mintPublicKey           // 代币mint地址
      );
      transaction.add(createATAInstruction);
    }

    // 添加转账指令
    const decimals = 6; // 根据你的代币实际情况修改
    const transferAmount = tokenAmount * Math.pow(10, decimals);
    
    console.log(`💰 Transferring ${tokenAmount} tokens (${transferAmount} raw units)`);
    
    const transferInstruction = createTransferInstruction(
      senderTokenAccount,        // 发送者代币账户
      recipientTokenAccount,     // 接收者代币账户
      senderKeypair.publicKey,   // 发送者地址
      transferAmount            // 转账数量
    );
    transaction.add(transferInstruction);

    // 设置最新的区块哈希
    console.log('⏳ Getting latest blockhash...');
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = senderKeypair.publicKey;

    console.log('🚀 Sending transaction...');

    // 发送交易
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [senderKeypair],
      {
        commitment: 'confirmed',
        skipPreflight: false
      }
    );

    console.log('✅ Transaction successful! Signature:', signature);

    // 在内存中记录这个钱包已经领取过空投
    // 注意：在 Vercel 无服务器环境中，这会在函数冷启动时重置
    claimedAddresses.add(walletAddress);
    
    // 返回交易签名
    const cluster = rpcUrl.includes('devnet') ? 'devnet' : 'mainnet';
    return res.status(200).json({
      success: true,
      signature: signature,
      amount: tokenAmount,
      message: `Successfully airdropped ${tokenAmount} DUCK tokens`,
      explorerUrl: `https://solscan.io/tx/${signature}?cluster=${cluster}`
    });

  } catch (error) {
    console.error('❌ Airdrop error:', error);

    // 处理特定错误
    if (error.message.includes('already in use')) {
      return res.status(400).json({ error: 'already_claimed_or_has_balance' });
    }

    return res.status(500).json({ 
      error: error.message || 'Internal server error during airdrop' 
    });
  }
}