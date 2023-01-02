import { getConnection, http, runQuery } from '@firestone-hs/aws-lambda-utils';
import { URLSearchParams } from 'url';
import { gzipSync } from 'zlib';
import { InternalDbRow, PresenceInfo, PresenceResult, TwitchInfo } from './model';
import { chunk } from './utils';

export default async (event): Promise<any> => {
	const mysql = await getConnection();
	const dbData: readonly InternalDbRow[] = await runQuery(
		mysql,
		// `
		//     SELECT * FROM twitch_presence
		//     WHERE lastUpdateDate >= DATE_SUB(NOW(), INTERVAL 1 HOUR);
		// `,
		`
            SELECT * FROM twitch_presence
        `,
		false,
	);
	await mysql.end();

	const userNameRegex = /^[a-z0-9_]+$/i;
	dbData.forEach(r => {
		if (!r.twitchUserName?.match(userNameRegex)) {
			console.log('invalid userName', r.twitchUserName);
		}
	});
	const validDbData = dbData.filter(r => r.twitchUserName?.match(userNameRegex));
	console.log('all valid user names', JSON.stringify(validDbData.map(r => r.twitchUserName)));

	const twitchInfo = await getTwitchInfo(validDbData.map(r => r.twitchUserName));
	const inDbButNotStreaming = validDbData
		.filter(d => !twitchInfo.some(t => t.user_login === d.twitchUserName))
		.map(info => info.twitchUserName);
	console.log('in db, but not streaming', inDbButNotStreaming);

	const mergedResult: readonly PresenceInfo[] = mergeInfos(validDbData, twitchInfo);
	const result: PresenceResult = {
		streams: mergedResult,
		lastUpdateDate: new Date(),
	};

	const stringResults = JSON.stringify(result);
	const gzippedResults = gzipSync(stringResults).toString('base64');
	const response = {
		statusCode: 200,
		isBase64Encoded: true,
		body: gzippedResults,
		headers: {
			'Content-Type': 'application/json',
			'Content-Encoding': 'gzip',
		},
	};
	return response;
};

const mergeInfos = (dbInfos: readonly InternalDbRow[], twitchInfos: readonly TwitchInfo[]): readonly PresenceInfo[] => {
	const relevantDbInfos = dbInfos.filter(info => {
		const isOk =
			info.gameStatus === 'ongoing' || Date.now() - new Date(info.lastUpdateDate).getTime() < 5 * 60 * 1000;
		if (!isOk) {
			console.debug(
				'not valid',
				info.twitchUserName,
				info.gameStatus,
				Date.now() - new Date(info.lastUpdateDate).getTime() < 5 * 60 * 1000,
				Date.now() - new Date(info.lastUpdateDate).getTime(),
			);
		}
		return isOk;
	});
	return twitchInfos
		.map(twitchInfo => {
			const dbInfo = relevantDbInfos.find(
				// Backward compatibility
				info => info.twitchUserName === twitchInfo.user_login || info.twitchUserName === twitchInfo.user_name,
			);

			if (!dbInfo) {
				console.debug('missing dbInfo', twitchInfo.user_login, twitchInfo);
				return null;
			}

			return {
				...twitchInfo,
				...dbInfo,
			};
		})
		.filter(info => !!info);
};

const getTwitchInfo = async (twitchUserNames: readonly string[]): Promise<readonly TwitchInfo[]> => {
	console.debug('getting info for usernames', twitchUserNames);
	const accessToken = await getTwitchAccessToken();
	const streamInfos = await getStreamsInfo(twitchUserNames, accessToken);
	return streamInfos.filter(info => info.game_id === '138585');
};

const getStreamsInfo = async (
	twitchUserNames: readonly string[],
	accessToken: string,
): Promise<readonly TwitchInfo[]> => {
	const listSize = 100;
	const chunks = chunk(twitchUserNames, listSize);
	const result: TwitchInfo[] = [];
	for (const chunk of chunks) {
		// TODO: chunnk the logins (limited to 100) and handle pagination
		const userLogins = chunk.map(name => `user_login=${name}`).join('&');
		const url = `https://api.twitch.tv/helix/streams?first=${listSize}&${userLogins}`;
		console.log('calling URL', url);
		const streamsResponseStr = await http(url, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Client-Id': '9meydlc19mc34srln9okbssehk9ji0',
			},
		});
		console.debug('streamsResponseStr', streamsResponseStr);
		const streamsResponse = JSON.parse(streamsResponseStr)?.data ?? [];
		console.debug('stream response', streamsResponse, JSON.parse(streamsResponseStr)?.data);
		result.push(...streamsResponse);
	}
	return result;
};

const getTwitchAccessToken = async (): Promise<string> => {
	// FIXME: extract this to the secret manager
	const details = {
		'client_id': '9meydlc19mc34srln9okbssehk9ji0',
		'client_secret': '9puvhtkc8wgclryr0v0i98bfemegm9',
		'grant_type': 'client_credentials',
	};
	const twitchResponse = await http('https://id.twitch.tv/oauth2/token', {
		method: 'POST',
		body: new URLSearchParams(details),
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
	});
	const accessToken = JSON.parse(twitchResponse)?.access_token;
	console.log('twitchResponse', accessToken, twitchResponse);
	return accessToken;
};
