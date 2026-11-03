# credentials.json placeholder
# 
# Step 1: Authenticate with Cloudflare
#   cloudflared tunnel login tv.51pwn.com
#
# Step 2: Create the tunnel
#   cloudflared tunnel create scrcpy-home
#   This outputs a UUID like: 12345678-1234-1234-1234-123456789012
#
# Step 3: Copy the credentials file
#   cp ~/.cloudflared/12345678-1234-1234-1234-123456789012.json \
#      ./cloudflare/credentials.json
#
# Step 4: Route DNS
#   cloudflared tunnel route dns scrcpy-home tv.51pwn.com
#
# Step 5: Update config.yml with correct tunnel name if different

# THIS FILE SHOULD BE REPLACED WITH YOUR ACTUAL credentials.json
