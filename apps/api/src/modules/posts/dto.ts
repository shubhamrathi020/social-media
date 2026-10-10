import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import { MAX_POST_SLIDES } from '@social/shared';

export class CreatePostDto {
  @IsOptional()
  @IsString()
  @MaxLength(2200)
  caption?: string;

  @IsOptional()
  @IsIn(['public', 'friends', 'close_friends'])
  audience?: 'public' | 'friends' | 'close_friends';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_POST_SLIDES, { message: `A post can have at most ${MAX_POST_SLIDES} slides` })
  @ArrayUnique()
  @IsUUID('all', { each: true })
  mediaIds!: string[];
}

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @MaxLength(2200)
  caption?: string;

  @IsOptional()
  @IsIn(['public', 'friends', 'close_friends'])
  audience?: 'public' | 'friends' | 'close_friends';
}

export class ReactDto {
  @IsIn([1, -1])
  value!: 1 | -1;
}

export class CreateCommentDto {
  @IsString()
  @Length(1, 1000)
  body!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class PageQuery {
  @IsOptional()
  @IsNumberString()
  cursor?: string;
}
