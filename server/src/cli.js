// Uso:
//   npm run create-user -- <usuario> <senha>
//   npm run reset-password -- <usuario> <nova-senha>
import { createUser, findUserRow, setPassword, validateCredentials } from './auth.js';
import { db } from './db.js';

const [command, username, password] = process.argv.slice(2);

const problem = validateCredentials(username, password);
if (problem) {
  console.error(problem);
  process.exit(1);
}

if (command === 'create-user') {
  if (findUserRow(username)) {
    console.error('Esse usuário já existe.');
    process.exit(1);
  }
  const user = createUser(username, password);
  console.log(`Usuário "${user.username}" criado${user.isAdmin ? ' (admin)' : ''}.`);
} else if (command === 'reset-password') {
  const row = findUserRow(username);
  if (!row) {
    console.error('Usuário não encontrado.');
    process.exit(1);
  }
  setPassword(row.id, password);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  console.log(`Senha de "${row.username}" redefinida. Sessões antigas encerradas.`);
} else {
  console.error('Comando desconhecido. Use create-user ou reset-password.');
  process.exit(1);
}
