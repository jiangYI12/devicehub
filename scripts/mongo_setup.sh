#!/bin/bash
set -euo pipefail

REPLICA_HOST="${MONGODB_REPLICA_HOST:-devicehub-mongo:27017}"

mongosh --host devicehub-mongo:27017 <<EOF
const desiredHost = "${REPLICA_HOST}";

try {
    const cfg = rs.conf();
    const needsReconfig =
        !cfg.members ||
        cfg.members.length !== 1 ||
        cfg.members[0].host !== desiredHost;

    if (needsReconfig) {
        cfg.members = [
            {
                _id: 0,
                host: desiredHost,
                priority: 2
            }
        ];
        rs.reconfig(cfg, { force: true });
    }
}
catch (err) {
    const notInitialized =
        err.codeName === 'NotYetInitialized' ||
        /no replset config has been received/i.test(err.message || '');

    if (!notInitialized) {
        throw err;
    }

    rs.initiate({
        _id: 'devicehub-rs',
        members: [
            {
                _id: 0,
                host: desiredHost,
                priority: 2
            }
        ]
    });
}
EOF
