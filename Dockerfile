# Use the official Node.js 16 image as the base image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to the working directory
COPY package.json package-lock.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code to the working directory
COPY . .

# Expose the port specified in the .env file
EXPOSE 3000

# Set environment variables (optional: .env file should be mounted during runtime)
ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"]
