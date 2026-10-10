import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'file'] as const;

export class SendMessageDto {
  @IsUUID()
  conversationId!: string;

  @IsString()
  @Length(8, 64)
  clientMsgId!: string;

  @IsIn(MESSAGE_TYPES)
  type!: (typeof MESSAGE_TYPES)[number];

  @IsObject()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsNumberString()
  replyToId?: string;
}

/** REST variant: the conversation comes from the URL. */
export class SendMessageBodyDto {
  @IsString()
  @Length(8, 64)
  clientMsgId!: string;

  @IsIn(MESSAGE_TYPES)
  type!: (typeof MESSAGE_TYPES)[number];

  @IsObject()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsNumberString()
  replyToId?: string;
}

export class CreateConversationDto {
  /** Direct chat with this user. */
  @ValidateIf((o) => !o.memberIds)
  @IsUUID()
  userId?: string;

  /** Group chat. */
  @ValidateIf((o) => !o.userId)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  title?: string;

  @ValidateIf((o) => !o.userId)
  @IsArray()
  @ArrayMaxSize(255)
  @IsUUID('all', { each: true })
  memberIds?: string[];
}

export class MarkReadDto {
  @IsNumberString()
  upToMessageId!: string;
}

export class DeliveredDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsNumberString({}, { each: true })
  messageIds!: string[];
}

export class ReadEventDto extends MarkReadDto {
  @IsUUID()
  conversationId!: string;
}

export class TypingDto {
  @IsUUID()
  conversationId!: string;
}

export class PresenceQueryDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  userIds!: string[];
}
