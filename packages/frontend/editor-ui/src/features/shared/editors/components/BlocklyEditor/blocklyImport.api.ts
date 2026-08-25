import type { ConvertBlocklySourceRequestDto, ConvertBlocklySourceResponse } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

export async function convertBlocklySource(
	context: IRestApiContext,
	request: ConvertBlocklySourceRequestDto,
): Promise<ConvertBlocklySourceResponse> {
	return await makeRestApiRequest(context, 'POST', '/blockly-source/convert', request);
}
