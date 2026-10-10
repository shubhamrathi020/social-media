import { Global, Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaProcessor } from './media.processor';
import { MediaService } from './media.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  controllers: [MediaController],
  providers: [StorageService, MediaProcessor, MediaService],
  exports: [MediaService],
})
export class MediaModule {}
