import { ArrayMaxSize, IsArray, IsString, IsUUID, MaxLength } from 'class-validator';

export class SendRequestDto {
  @IsUUID()
  toUser!: string;
}

export class SyncContactsDto {
  /** Phone numbers from the address book in E.164 form. They are hashed with a server key and never stored. */
  @IsArray()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  phones!: string[];
}
