#!/bin/sh
set -e

# Install crontab for root
mkdir -p /etc/crontabs
cp /app/crontab /etc/crontabs/root

# Ensure log file exists
touch /var/log/scheduler.log

echo "Starting cron (daily 13:00 Europe/Berlin)..."
exec crond -f -l 2
