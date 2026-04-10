# Scenario C: Cloud Relay Deployment Guide (Google Cloud Platform)

Because the DTU device relies on a **Raw TCP Socket** instead of standard HTTP web traffic, standard web hosting providers (like Render or Vercel) will bounce the connection. We must use a full virtual machine. 

This guide covers creating an **Always Free Google Cloud Platform (GCP)** server to act as a permanent, public bridge from your DTU to LakeLedger.

### 1. Launch a Free GCP Compute Engine Instance
1. **Create an account** at [cloud.google.com](https://cloud.google.com/) and create a new Project.
2. Go to **Compute Engine** -> **VM Instances** and click **Create Instance**.
3. **Name it:** `dtu-bridge-vm`.
4. **Region:** You **MUST** select one of the following to stay in the Free Tier: `us-central1` (Iowa), `us-east1` (South Carolina), or `us-west1` (Oregon).
5. **Machine Configuration:** Select **General purpose** -> **E2** -> **e2-micro**.
6. **Boot Disk:** Change the OS to **Ubuntu** (leave version as default).
7. **Firewall:** Check both "Allow HTTP traffic" and "Allow HTTPS traffic" (just in case).
8. Click **Create**.

### 2. Open the TCP Port via GCP Firewall
GCP blocks non-standard ports by default. We need to open Port 3000 for your DTU.
1. Click the hamburger menu (top left) and go to **VPC Network** -> **Firewall**.
2. Click **Create Firewall Rule** at the top.
3. **Name:** `allow-dtu-tcp-3000`
4. **Targets:** `All instances in the network`
5. **Source IPv4 ranges:** `0.0.0.0/0`
6. **Protocols and ports:** Check `TCP` and type `3000`.
7. Click **Create**.

### 3. Connect to Your Server (Super Easy)
Unlike AWS, Google Cloud lets you SSH directly from your browser!
1. Go back to your **Compute Engine VM Instances** page.
2. Find your `dtu-bridge-vm` and click the **SSH** button next to it. 
3. A terminal window will securely open in your browser.

### 4. Install Node.js & Download the Kit
Inside the browser SSH terminal, run these exact commands one by one to install Node.js and download your code:

```bash
# 1. Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Download your Code repository
git clone https://github.com/kbvideo6/Scenario_C_Cloud_Relay_Kit.git
cd Scenario_C_Cloud_Relay_Kit

# 3. Install packages
npm install
```

### 5. Run the Bridge Permanently!
We will use an app called `PM2` to run the bridge in the background so it stays alive even if you close your browser or the server restarts.

```bash
# 1. Install PM2
sudo npm install -g pm2

# 2. Start the bridge
pm2 start bridge.js --name "dtu-gateway"

# 3. (Optional) Save it so it auto-starts on reboot
pm2 save
pm2 startup
```

*(If `pm2 startup` gives you a custom command to run, copy/paste and run it!).*

### 6. Update your DTU Settings
Your bridge is now live on the internet! 

1. Go back to your GCP VM Instances page and copy the **External IP** address of your VM.
2. In your physical DTU interface, configure it to send data to a Custom Server.
3. **Target IP:** `<YOUR_GCP_EXTERNAL_IP>` 
4. **Target Port:** `3000`

The DTU will connect directly to your GCP Virtual Machine, and `bridge.js` will securely process the raw TCP packets and pump them straight to LakeLedger.
