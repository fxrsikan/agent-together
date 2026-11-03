export function validateLogin(email: string, password: string): string[] {
  const errors: string[] = [];
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push("邮箱格式不正确");
  if (password.length < 8) errors.push("密码至少 8 位");
  return errors;
}
