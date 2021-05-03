import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {
    QueryService_v1Client as QueryService,
    CommandService_v1Client as CommandService
} from 'iroha-helpers/lib/proto/endpoint_grpc_pb';
import { Transaction } from 'iroha-helpers/lib/proto/transaction_pb';
import commands from 'iroha-helpers/lib/commands'
import queries from 'iroha-helpers/lib/queries';
import { TxBuilder } from 'iroha-helpers/lib/chain';
import { Buffer } from 'buffer';

admin.initializeApp();

const grpc = require('grpc');

const IROHA_ADDRESS = "localhost:50051";
const IROHA_DOMAIN_ID = "test"
const ASSET_ID = "hamiot#test";
const ADMIN_ACCOUNT_ID = "admin@test";
const ADMIN_PRIV_KEY = 'f101537e319568c765b2cc89698325604991dca57b9716b58016b253506cab70';

const commandService = new CommandService(
    IROHA_ADDRESS,
    grpc.credentials.createInsecure()
);
const queryService = new QueryService(
    IROHA_ADDRESS,
    grpc.credentials.createInsecure()
);

async function getDisplayName(accountId: string) {
    try {
        interface DisplayName {
            displayName: string;
        }
        interface DisplayNameResult {
            [index: string]: DisplayName;
        }

        const result = await queries.getAccountDetail({
            privateKey: ADMIN_PRIV_KEY,
            creatorAccountId: ADMIN_ACCOUNT_ID,
            queryService,
            timeoutLimit: 1000
        }, {
            accountId,
            key: 'displayName',
            writer: accountId,
            pageSize: 1,
            paginationKey: 'displayName',
            paginationWriter: accountId
        }) as DisplayNameResult;

        const displayName = result[accountId].displayName;
        if (!displayName) {
            return null;
        }

        // Send back the result
        return displayName;
    } catch (e) {
        return null;
    }
}

async function getFcmToken(accountId: string) {
    try {
        interface FcmToken {
            fcmToken: string;
        }
        interface FcmTokenResult {
            [index: string]: FcmToken;
        }

        const result = await queries.getAccountDetail({
            privateKey: ADMIN_PRIV_KEY,
            creatorAccountId: ADMIN_ACCOUNT_ID,
            queryService,
            timeoutLimit: 1000
        }, {
            accountId,
            key: 'fcmToken',
            writer: accountId,
            pageSize: 1,
            paginationKey: 'fcmToken',
            paginationWriter: accountId
        }) as FcmTokenResult;

        const fcmToken = result[accountId].fcmToken;
        if (!fcmToken) {
            return null;
        }

        // Send back the result
        return fcmToken;
    } catch (e) {
        return null;
    }
}

exports.newAccount = functions.region('asia-northeast1').https.onCall(async (data, context) => {
    // public key
    const publicKey = data.publicKey;

    // Validation
    if (publicKey == undefined) {
        return {
            result: 'NG',
            detail: 'Validation error'
        };
    }

    // Create account id
    const accountName = String(Date.now());
    const accountId = accountName + "@" + IROHA_DOMAIN_ID;

    // Create account
    // Execute
    try {
        await commands.createAccount({
            privateKeys: [ADMIN_PRIV_KEY],
            creatorAccountId: ADMIN_ACCOUNT_ID,
            quorum: 1,
            commandService,
            timeoutLimit: 1000
        }, {
            accountName: accountName,
            domainId: IROHA_DOMAIN_ID,
            publicKey: publicKey
        });
    } catch (e) {
        return {
            result: 'NG',
            detail: 'Failure to create account: ' + e
        };
    }

    // Send back the result
    return {
        result: 'OK',
        accountId,
        irohaAddress: IROHA_ADDRESS
    };
});

exports.getPublicUserData = functions.region('asia-northeast1').https.onCall(async (data, context) => {
    const accountId = data.accountId;

    // Validation
    if (accountId == undefined) {
        return {
            result: 'NG',
            detail: 'Validation error'
        };
    }

    const displayName = await getDisplayName(accountId);
    if (!displayName) {
        return {result: 'NG', detail: 'displayName is null', accountId};
    }
    return {result: 'OK', displayName};
});

exports.transferAsset = functions.region('asia-northeast1').https.onCall(async (data, context) => {
    const transactionData = data.transaction;

    // Validation
    if (transactionData == undefined) {
        return {
            result: 'NG',
            detail: 'Validation error'
        };
    }

    const transactionBinary = Buffer.from(transactionData, 'base64');
    const transaction = Transaction.deserializeBinary(transactionBinary);
    const payload = transaction.getPayload();
    const command = payload?.getReducedPayload()?.getCommandsList()[0];
    if (!command?.hasTransferAsset) {
        return {
            result: 'NG',
            detail: 'Transaction has no transfer commands'
        };
    }

    const transferAsset = command.getTransferAsset();
    const amount = transferAsset?.getAmount();
    const assetId = transferAsset?.getAssetId();
    const srcAccountId = transferAsset?.getSrcAccountId();
    const destAccountId = transferAsset?.getDestAccountId();

    if (!amount || assetId != ASSET_ID || !srcAccountId || !destAccountId) {
        return {
            result: 'NG',
            detail: 'Cannot get transfer parameters'
        };
    }

    const amountInt = Number(amount);
    if (amountInt <= 0) {
        return {
            result: 'NG',
            detail: 'Amount is invalid'
        };
    }
    
    // Execute transfer transaction
    try {
        await new TxBuilder(transaction).send(commandService);
    } catch (e) {
        return {
            result: 'NG',
            detail: 'Failure send transfer transaction: ' + e
        };
    }

    const srcDisplayName = await getDisplayName(srcAccountId);
    const destDisplayName = await getDisplayName(destAccountId);
    const srcFcmToken = await getFcmToken(srcAccountId);
    const destFcmToken = await getFcmToken(destAccountId);

    var promises: Promise<string>[] = Array();

    // Send FCM to destination user
    if (destFcmToken && srcDisplayName) {
        const message = {
            data: {
                type: 'ReceiveAsset',
                amount: amount,
                opponentAccountId: srcAccountId,
                opponentDisplayName: srcDisplayName
            },
            token: destFcmToken
        };
        promises.push(admin.messaging().send(message));
    }

    // Send FCM to source user
    if (srcFcmToken && destDisplayName) {
        const message = {
            data: {
                type: 'SentAsset',
                amount: amount,
                opponentAccountId: destAccountId,
                opponentDisplayName: destDisplayName
            },
            token: srcFcmToken
        };
        promises.push(admin.messaging().send(message));
    }

    // Execute send FCM
    if (promises.length > 0) {
        Promise.all(promises).then(results => { 
            // success
        }).catch(reject => { 
            // error
        });
    }

    return {
        result: 'OK'
    };
});
