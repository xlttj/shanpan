export class UserService {
  getUser(id: string): string {
    return id;
  }

  createUser(name: string): void {
    console.log(name);
  }
}

export function hashPassword(password: string): string {
  return password;
}

export interface IUserRepository {
  findById(id: string): string | null;
}

export type UserId = string;

export enum UserRole {
  Admin = 'admin',
  User = 'user',
}
