import {createPool} from "mysql2/promise";
/**
 * MYSQL_HOST="vp-mariadb-1.clm6s08i2xux.ap-northeast-2.rds.amazonaws.com"
 * MYSQL_PORT=3306
 * MYSQL_USER=admin
 * MYSQL_PASSWORD="!L0Y|J7iy8Y4z7#G<(BmwK~Y-bwK"
 * MYSQL_DATABASE=obdomain
 */
const pool = createPool({
    host: 'vp-mariadb-1.clm6s08i2xux.ap-northeast-2.rds.amazonaws.com',
    port: 3306,
    user: 'admin',
    password: '!L0Y|J7iy8Y4z7#G<(BmwK~Y-bwK',
    database: 'obdomain',

    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0,
})

pool.getConnection().then(connection => {
    // INSERT 쿼리 실행
    const query = `
  INSERT INTO user (id, sequence_number, connect_info, name, phone_number, birth, gender, email) 
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

    const values = [
        'support',
        '1',
        'support',
        'support',
        '010-0000-0000',
        '1990-01-01',
        'M',
        'w'
    ];

    connection.execute(query, values).then(result => {
        console.log(result);
    }).catch(err => {
        console.error(err);
    }).finally(() => {
        connection.release();
        pool.end()
    })
})