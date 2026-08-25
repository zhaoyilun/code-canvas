import type { ConvertBlocklySourceResponse } from '@n8n/api-types';
import { ConvertBlocklySourceRequestDto } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import { Body, Post, RestController } from '@n8n/decorators';
import type { Response } from 'express';

import { BlocklySourceConversionService } from '@/services/blockly-source-conversion.service';

@RestController('/blockly-source')
export class BlocklySourceController {
	constructor(private readonly blocklySourceConversionService: BlocklySourceConversionService) {}

	@Post('/convert')
	async convert(
		_req: AuthenticatedRequest,
		_res: Response,
		@Body payload: ConvertBlocklySourceRequestDto,
	): Promise<ConvertBlocklySourceResponse> {
		return await this.blocklySourceConversionService.convert(payload);
	}
}
