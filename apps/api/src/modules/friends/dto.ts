import { ArrayMaxSize, IsArray, IsUUID, Matches } from 'class-validator';

export class SendRequestDto {
  @IsUUID()
  toUser!: string;
}

export class SyncContactsDto {
  @IsArray()
  @ArrayMaxSize(5000)
  @Matches(/^[0-9a-fA-F]{64}$/, { each: true, message: 'each hash must be a sha256 hex string' })
  hashes!: string[];
}
