import { IsIn, IsInt, IsString, Max, Min } from 'class-validator';

export class RequestUploadDto {
  @IsIn(['image', 'video', 'audio', 'file'])
  kind!: 'image' | 'video' | 'audio' | 'file';

  @IsIn(['avatar', 'post', 'story', 'status', 'chat'])
  purpose!: 'avatar' | 'post' | 'story' | 'status' | 'chat';

  @IsString()
  mime!: string;

  @IsInt()
  @Min(1)
  @Max(200 * 1024 * 1024)
  sizeBytes!: number;
}
