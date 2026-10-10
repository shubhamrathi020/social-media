import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateIf } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @Matches(/^[a-z0-9_.]{3,30}$/, {
    message: 'username must be 3-30 chars: lowercase letters, digits, "_" or "."',
  })
  username?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  bio?: string;

  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;

  /** Id of a ready 'avatar' media object, or null to remove the avatar. */
  @ValidateIf((_, v) => v !== undefined && v !== null)
  @IsUUID()
  avatarMediaId?: string | null;
}
